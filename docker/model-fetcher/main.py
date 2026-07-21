"""Bounded, persistent Hugging Face model download service."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from enum import Enum
from pathlib import Path, PurePosixPath
from typing import Optional
from urllib.parse import urljoin, urlparse

import requests
from fastapi import FastAPI, HTTPException
from huggingface_hub import HfApi, hf_hub_url
from pydantic import BaseModel, ConfigDict, field_validator

MODELS_DIR = Path(os.environ.get("MODELS_DIR", "/models")).resolve()
PORT = int(os.environ.get("PORT", "7423"))
HF_TOKEN: Optional[str] = os.environ.get("HF_TOKEN") or None
MAX_ACTIVE = int(os.environ.get("MAX_ACTIVE_DOWNLOADS", "2"))
MAX_QUEUED = int(os.environ.get("MAX_QUEUED_DOWNLOADS", "25"))
MAX_FILE_BYTES = int(os.environ.get("MAX_MODEL_BYTES", str(100 * 1024**3)))
DISK_RESERVE_BYTES = int(os.environ.get("MODEL_DISK_RESERVE_BYTES", str(10 * 1024**3)))
STATE_DIR = MODELS_DIR / ".interloom"
STATE_FILE = STATE_DIR / "download-jobs.json"

REPO_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,95}/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$")
REVISION_RE = re.compile(r"^(?:[0-9a-fA-F]{40}|[A-Za-z0-9][A-Za-z0-9._/-]{0,254})$")
SHA256_RE = re.compile(r"^[0-9a-fA-F]{64}$")
ALLOWED_DOWNLOAD_HOSTS = (
    "huggingface.co",
    ".huggingface.co",
    ".hf.co",
    ".hfusercontent.com",
    ".xethub.hf.co",
)

app = FastAPI(title="interloom-model-fetcher")


class DownloadStatus(str, Enum):
    queued = "queued"
    downloading = "downloading"
    done = "done"
    error = "error"


def validate_repo_id(value: str) -> str:
    if not REPO_RE.fullmatch(value):
        raise ValueError("repoId must be exactly owner/name")
    return value


def validate_revision(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    if not REVISION_RE.fullmatch(value) or value.startswith("-"):
        raise ValueError("revision is not a safe ref or commit")
    parts = value.split("/")
    if any(part in ("", ".", "..") for part in parts) or "\\" in value or "\x00" in value:
        raise ValueError("revision contains an unsafe segment")
    return value


def validate_filename(value: str) -> str:
    if not value or len(value) > 1024 or "\\" in value or "\x00" in value:
        raise ValueError("filename is invalid")
    if re.search(r"%(?:00|2e|2f|5c)", value, re.IGNORECASE):
        raise ValueError("filename contains an encoded path separator")
    raw_parts = value.split("/")
    if any(part in ("", ".", "..") for part in raw_parts):
        raise ValueError("filename contains an unsafe segment")
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in ("", ".", "..") for part in path.parts):
        raise ValueError("filename contains an unsafe segment")
    return path.as_posix()


class DownloadRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    repoId: str
    filename: str
    revision: Optional[str] = None
    hfToken: Optional[str] = None
    expectedSha256: Optional[str] = None

    @field_validator("repoId")
    @classmethod
    def repo_id_valid(cls, value: str) -> str:
        return validate_repo_id(value)

    @field_validator("filename")
    @classmethod
    def filename_valid(cls, value: str) -> str:
        return validate_filename(value)

    @field_validator("revision")
    @classmethod
    def revision_valid(cls, value: Optional[str]) -> Optional[str]:
        return validate_revision(value)

    @field_validator("expectedSha256")
    @classmethod
    def digest_valid(cls, value: Optional[str]) -> Optional[str]:
        if value is not None and not SHA256_RE.fullmatch(value):
            raise ValueError("expectedSha256 must be a hex SHA-256 digest")
        return value.lower() if value else None

    @field_validator("hfToken")
    @classmethod
    def token_bounded(cls, value: Optional[str]) -> Optional[str]:
        if value is not None and (not value or len(value) > 4096 or "\x00" in value):
            raise ValueError("hfToken is invalid")
        return value


class DownloadState:
    def __init__(
        self,
        id_: str,
        repo_id: str,
        filename: str,
        revision: Optional[str],
        hf_token: Optional[str] = None,
        expected_sha256: Optional[str] = None,
    ):
        self.id = id_
        self.repo_id = repo_id
        self.filename = filename
        self.revision = revision
        self.resolved_revision: Optional[str] = None
        self.expected_sha256 = expected_sha256
        self._hf_token = hf_token  # memory-only; never persisted or returned
        self.status = DownloadStatus.queued
        self.bytes_done = 0
        self.bytes_total = 0
        self.speed_bps = 0.0
        self.error: Optional[str] = None
        self._lock = threading.Lock()

    def to_dict(self) -> dict:
        with self._lock:
            return {
                "id": self.id,
                "repoId": self.repo_id,
                "filename": self.filename,
                "revision": self.revision,
                **({"resolvedRevision": self.resolved_revision} if self.resolved_revision else {}),
                "status": self.status.value,
                "bytesDone": self.bytes_done,
                "bytesTotal": self.bytes_total,
                "speedBps": round(self.speed_bps, 1),
                **({"expectedSha256": self.expected_sha256} if self.expected_sha256 else {}),
                **({"error": self.error} if self.error else {}),
            }

    def persisted(self) -> dict:
        return self.to_dict()


_downloads: dict[str, DownloadState] = {}
_key_to_id: dict[tuple[str, str], str] = {}
_reservations: dict[str, int] = {}
_lock = threading.Lock()
_executor = ThreadPoolExecutor(max_workers=MAX_ACTIVE, thread_name_prefix="model-download")


def _download_key(repo_id: str, filename: str) -> tuple[str, str]:
    return (repo_id, filename)


def _persist_locked() -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    temp = STATE_FILE.with_suffix(".tmp")
    temp.write_text(json.dumps([state.persisted() for state in _downloads.values()], indent=2), encoding="utf-8")
    os.replace(temp, STATE_FILE)


def _persist() -> None:
    with _lock:
        _persist_locked()


def _load_persisted() -> None:
    if not STATE_FILE.exists():
        return
    try:
        rows = json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return
    if not isinstance(rows, list):
        return
    with _lock:
        for row in rows[: MAX_ACTIVE + MAX_QUEUED + 100]:
            try:
                state = DownloadState(
                    str(row["id"]),
                    validate_repo_id(str(row["repoId"])),
                    validate_filename(str(row["filename"])),
                    validate_revision(row.get("revision")),
                    expected_sha256=row.get("expectedSha256"),
                )
                old_status = DownloadStatus(row.get("status", "error"))
                state.status = old_status if old_status in (DownloadStatus.done, DownloadStatus.error) else DownloadStatus.error
                state.error = row.get("error") or ("download interrupted by service restart" if old_status != DownloadStatus.done else None)
                state.bytes_done = int(row.get("bytesDone", 0))
                state.bytes_total = int(row.get("bytesTotal", 0))
                state.resolved_revision = row.get("resolvedRevision")
                _downloads[state.id] = state
                _key_to_id[_download_key(state.repo_id, state.filename)] = state.id
            except (KeyError, TypeError, ValueError):
                continue


def _repo_root(repo_id: str) -> Path:
    validate_repo_id(repo_id)
    owner, name = repo_id.split("/", 1)
    root = (MODELS_DIR / f"{owner}__{name}").resolve(strict=False)
    if not root.is_relative_to(MODELS_DIR):
        raise ValueError("repository destination escapes model directory")
    return root


def _dest_path(repo_id: str, filename: str) -> Path:
    safe_filename = validate_filename(filename)
    repo_root = _repo_root(repo_id)
    destination = (repo_root / PurePosixPath(safe_filename)).resolve(strict=False)
    if not destination.is_relative_to(repo_root):
        raise ValueError("download destination escapes repository directory")
    current = destination.parent
    while current != repo_root.parent:
        if current.exists() and not current.resolve().is_relative_to(repo_root):
            raise ValueError("download ancestor escapes repository directory")
        if current == repo_root:
            break
        current = current.parent
    return destination


def _metadata(state: DownloadState, token: Optional[str]) -> tuple[str, Optional[str], Optional[int]]:
    info = HfApi(token=token).model_info(
        state.repo_id,
        revision=state.revision or "main",
        files_metadata=True,
    )
    resolved = info.sha
    if not resolved or not re.fullmatch(r"[0-9a-fA-F]{40}", resolved):
        raise ValueError("Hub did not return an immutable revision")
    digest: Optional[str] = state.expected_sha256
    size: Optional[int] = None
    for sibling in info.siblings or []:
        if sibling.rfilename != state.filename:
            continue
        size = sibling.size
        lfs = sibling.lfs
        lfs_digest = (
            lfs.get("sha256") if isinstance(lfs, dict) else getattr(lfs, "sha256", None)
        )
        if isinstance(lfs_digest, str):
            lfs_digest = lfs_digest.lower()
            if digest and digest.lower() != lfs_digest:
                raise ValueError("configured digest does not match Hub LFS metadata")
            digest = lfs_digest
        break
    return resolved.lower(), digest, size


def _download_host_allowed(url: str) -> bool:
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    return (
        parsed.scheme == "https"
        and parsed.username is None
        and parsed.password is None
        and any(
            host.endswith(suffix) if suffix.startswith(".") else host == suffix
            for suffix in ALLOWED_DOWNLOAD_HOSTS
        )
    )


def _stream_download(url: str, headers: dict[str, str]) -> requests.Response:
    current = url
    current_headers = dict(headers)
    for _ in range(6):
        if not _download_host_allowed(current):
            raise ValueError("download destination is not an approved Hub host")
        try:
            response = requests.get(
                current,
                headers={**current_headers, "Accept-Encoding": "identity"},
                stream=True,
                timeout=(10, 30),
                allow_redirects=False,
            )
        except requests.RequestException as exc:
            raise ValueError("download connection failed") from exc
        if response.status_code not in (301, 302, 303, 307, 308):
            return response
        location = response.headers.get("location")
        response.close()
        if not location:
            raise ValueError("Hub redirect omitted a destination")
        next_url = urljoin(current, location)
        if not _download_host_allowed(next_url):
            raise ValueError("Hub redirected to an unapproved download host")
        if urlparse(next_url).hostname != urlparse(current).hostname:
            current_headers.pop("Authorization", None)
        current = next_url
    raise ValueError("too many Hub redirects")


def _reserve_download(download_id: str, required_bytes: int) -> None:
    with _lock:
        free = shutil.disk_usage(MODELS_DIR).free
        reserved = sum(_reservations.values())
        if free - reserved - required_bytes < DISK_RESERVE_BYTES:
            raise ValueError("insufficient disk reserve")
        _reservations[download_id] = required_bytes


def _release_reservation(download_id: str) -> None:
    with _lock:
        _reservations.pop(download_id, None)


def _run_download(state: DownloadState) -> None:
    try:
        with state._lock:
            state.status = DownloadStatus.downloading
            state.error = None
        _persist()

        dest = _dest_path(state.repo_id, state.filename)
        dest.parent.mkdir(parents=True, exist_ok=True)
        # Re-check after mkdir: an attacker racing a writable volume must not
        # replace an ancestor with a symlink between validation and open.
        if not dest.parent.resolve().is_relative_to(_repo_root(state.repo_id)):
            raise ValueError("download ancestor escaped repository directory")
        part = Path(str(dest) + ".part")
        if part.is_symlink() or (part.exists() and not part.is_file()):
            raise ValueError("unsafe partial-download path")

        effective_token = state._hf_token or HF_TOKEN
        resolved_revision, expected_digest, metadata_size = _metadata(state, effective_token)
        state.resolved_revision = resolved_revision
        state.expected_sha256 = expected_digest
        url = hf_hub_url(state.repo_id, state.filename, revision=resolved_revision)

        headers: dict[str, str] = {}
        if effective_token:
            headers["Authorization"] = f"Bearer {effective_token}"
        resume_from = part.stat().st_size if part.exists() else 0
        if resume_from > 0:
            headers["Range"] = f"bytes={resume_from}-"

        response = _stream_download(url, headers)
        if response.status_code < 200 or response.status_code >= 300:
            response.close()
            raise ValueError(f"download server returned HTTP {response.status_code}")

        content_length = response.headers.get("content-length")
        if content_length is None:
            raise ValueError("download size is required")
        remaining = int(content_length)
        if response.status_code != 206:
            resume_from = 0
        total = resume_from + remaining
        if metadata_size is not None and total != metadata_size:
            raise ValueError("Hub metadata size does not match response")
        if total <= 0 or total > MAX_FILE_BYTES:
            raise ValueError("model file exceeds configured size limit")
        required_new_bytes = max(0, total - resume_from)
        _reserve_download(state.id, required_new_bytes)

        with state._lock:
            state.bytes_total = total
            state.bytes_done = resume_from

        hasher = hashlib.sha256()
        if resume_from:
            with open(part, "rb") as existing:
                for chunk in iter(lambda: existing.read(1 << 20), b""):
                    hasher.update(chunk)

        flags = os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW
        flags |= os.O_APPEND if resume_from else os.O_TRUNC
        fd = os.open(part, flags, 0o600)
        samples: list[tuple[float, int]] = []
        bytes_written = resume_from
        last_sample = time.monotonic()
        try:
            with os.fdopen(fd, "ab" if resume_from else "wb") as output:
                for chunk in response.iter_content(chunk_size=1 << 17):
                    if not chunk:
                        continue
                    bytes_written += len(chunk)
                    if bytes_written > total or bytes_written > MAX_FILE_BYTES:
                        raise ValueError("download exceeded reserved size")
                    output.write(chunk)
                    hasher.update(chunk)
                    now = time.monotonic()
                    if now - last_sample >= 0.5:
                        samples.append((now, bytes_written))
                        samples = [sample for sample in samples if sample[0] >= now - 4.0]
                        speed = 0.0
                        if len(samples) >= 2:
                            elapsed = samples[-1][0] - samples[0][0]
                            speed = (samples[-1][1] - samples[0][1]) / elapsed if elapsed > 0 else 0.0
                        with state._lock:
                            state.bytes_done = bytes_written
                            state.speed_bps = max(0.0, speed)
                        last_sample = now
        finally:
            response.close()

        if bytes_written != total:
            raise ValueError("download ended before the declared size")
        actual_digest = hasher.hexdigest()
        if expected_digest and actual_digest.lower() != expected_digest.lower():
            raise ValueError("download SHA-256 mismatch")

        os.replace(part, dest)
        with state._lock:
            state.bytes_done = total
            state.speed_bps = 0.0
            state.status = DownloadStatus.done
        _persist()
    except Exception as exc:  # error text contains no token or URL query
        with state._lock:
            state.status = DownloadStatus.error
            state.speed_bps = 0.0
            state.error = str(exc)[:512]
        _persist()
    finally:
        _release_reservation(state.id)


@app.on_event("startup")
def startup() -> None:
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    _load_persisted()


@app.post("/downloads", status_code=202)
def start_download(req: DownloadRequest) -> dict:
    key = _download_key(req.repoId, req.filename)
    with _lock:
        if key in _key_to_id:
            existing_id = _key_to_id[key]
            state = _downloads[existing_id]
            with state._lock:
                if state.status in (DownloadStatus.queued, DownloadStatus.downloading, DownloadStatus.done):
                    return {"id": existing_id}
            del _key_to_id[key]
            del _downloads[existing_id]

        queued = sum(
            state.status in (DownloadStatus.queued, DownloadStatus.downloading)
            for state in _downloads.values()
        )
        if queued >= MAX_ACTIVE + MAX_QUEUED:
            raise HTTPException(status_code=429, detail="download_queue_full")

        download_id = str(uuid.uuid4())
        state = DownloadState(
            download_id,
            req.repoId,
            req.filename,
            req.revision,
            req.hfToken,
            req.expectedSha256,
        )
        _downloads[download_id] = state
        _key_to_id[key] = download_id
        _persist_locked()

    _executor.submit(_run_download, state)
    return {"id": download_id}


@app.get("/downloads")
def list_downloads() -> list:
    with _lock:
        states = list(_downloads.values())
    return [state.to_dict() for state in states]


@app.get("/livez")
def livez() -> dict:
    return {"ok": True}


@app.get("/readyz")
def readyz() -> dict:
    writable = os.access(MODELS_DIR, os.W_OK) and os.access(STATE_DIR, os.W_OK)
    if not writable:
        raise HTTPException(status_code=503, detail="models_directory_not_writable")
    return {"ok": True}


@app.get("/health")
def health() -> dict:
    return readyz()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=PORT)
