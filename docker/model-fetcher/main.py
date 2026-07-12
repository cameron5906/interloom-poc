"""
Interloom model-fetcher service.

Manages downloads from Hugging Face Hub into MODELS_DIR.
Endpoints (CONTRACTS §7):
  POST /downloads  {repoId, filename, revision?}  -> {id}
  GET  /downloads                                  -> [{id, repoId, filename, status, bytesDone, bytesTotal, speedBps, error?}]
"""

from __future__ import annotations

import collections
import os
import threading
import time
import uuid
from enum import Enum
from pathlib import Path
from typing import Optional

import requests
from fastapi import FastAPI
from huggingface_hub import hf_hub_url
from pydantic import BaseModel

MODELS_DIR = Path(os.environ.get("MODELS_DIR", "/models"))
PORT = int(os.environ.get("PORT", 7423))
HF_TOKEN: Optional[str] = os.environ.get("HF_TOKEN") or None

app = FastAPI(title="interloom-model-fetcher")


class DownloadStatus(str, Enum):
    queued = "queued"
    downloading = "downloading"
    done = "done"
    error = "error"


class DownloadState:
    def __init__(self, id_: str, repo_id: str, filename: str, revision: Optional[str]):
        self.id = id_
        self.repo_id = repo_id
        self.filename = filename
        self.revision = revision
        self.status = DownloadStatus.queued
        self.bytes_done: int = 0
        self.bytes_total: int = 0
        self.speed_bps: float = 0.0
        self.error: Optional[str] = None
        self._lock = threading.Lock()

    def to_dict(self) -> dict:
        with self._lock:
            return {
                "id": self.id,
                "repoId": self.repo_id,
                "filename": self.filename,
                "status": self.status.value,
                "bytesDone": self.bytes_done,
                "bytesTotal": self.bytes_total,
                "speedBps": round(self.speed_bps, 1),
                **({"error": self.error} if self.error else {}),
            }


# In-memory download registry — key is (repoId, filename)
_downloads: dict[str, DownloadState] = {}
_key_to_id: dict[tuple[str, str], str] = {}
_lock = threading.Lock()


def _download_key(repo_id: str, filename: str) -> tuple[str, str]:
    return (repo_id, filename)


def _dest_path(repo_id: str, filename: str) -> Path:
    safe_repo = repo_id.replace("/", "__")
    return MODELS_DIR / safe_repo / filename


def _resolve_url(repo_id: str, filename: str, revision: Optional[str]) -> str:
    rev = revision or "main"
    return f"https://huggingface.co/{repo_id}/resolve/{rev}/{filename}"


def _run_download(state: DownloadState) -> None:
    dest = _dest_path(state.repo_id, state.filename)
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_suffix(dest.suffix + ".part")

    try:
        with state._lock:
            state.status = DownloadStatus.downloading

        url = _resolve_url(state.repo_id, state.filename, state.revision)

        # Resolve redirect to get the real URL (handles HF CDN redirects)
        headers: dict[str, str] = {}
        if HF_TOKEN:
            headers["Authorization"] = f"Bearer {HF_TOKEN}"

        # Resume from existing .part file
        resume_from = part.stat().st_size if part.exists() else 0
        if resume_from > 0:
            headers["Range"] = f"bytes={resume_from}-"

        response = requests.get(url, headers=headers, stream=True, timeout=30)
        response.raise_for_status()

        total_from_header = int(response.headers.get("content-length", 0))
        if response.status_code == 206:
            # Partial content — total is resume_from + remaining
            total = resume_from + total_from_header
        else:
            total = total_from_header
            resume_from = 0  # Server didn't honour Range; start fresh

        with state._lock:
            state.bytes_total = total
            state.bytes_done = resume_from

        # Rolling window for speed calculation (last 4 seconds of samples)
        _WINDOW = 4.0
        _SAMPLE_INTERVAL = 0.5
        samples: collections.deque[tuple[float, int]] = collections.deque()
        last_sample_time = time.monotonic()
        bytes_written = resume_from

        mode = "ab" if resume_from > 0 else "wb"
        with open(part, mode) as fh:
            for chunk in response.iter_content(chunk_size=1 << 17):  # 128 KiB
                if not chunk:
                    continue
                fh.write(chunk)
                bytes_written += len(chunk)

                now = time.monotonic()
                if now - last_sample_time >= _SAMPLE_INTERVAL:
                    samples.append((now, bytes_written))
                    # Evict samples older than the window
                    cutoff = now - _WINDOW
                    while samples and samples[0][0] < cutoff:
                        samples.popleft()

                    speed = 0.0
                    if len(samples) >= 2:
                        dt = samples[-1][0] - samples[0][0]
                        db = samples[-1][1] - samples[0][1]
                        speed = db / dt if dt > 0 else 0.0

                    with state._lock:
                        state.bytes_done = bytes_written
                        state.speed_bps = max(0.0, speed)
                    last_sample_time = now

        # Atomic rename on success
        part.rename(dest)

        final_size = dest.stat().st_size
        with state._lock:
            state.bytes_done = final_size
            if state.bytes_total == 0:
                state.bytes_total = final_size
            state.speed_bps = 0.0
            state.status = DownloadStatus.done

    except Exception as exc:
        with state._lock:
            state.status = DownloadStatus.error
            state.error = str(exc)


class DownloadRequest(BaseModel):
    repoId: str
    filename: str
    revision: Optional[str] = None


@app.post("/downloads", status_code=202)
def start_download(req: DownloadRequest) -> dict:
    key = _download_key(req.repoId, req.filename)
    with _lock:
        if key in _key_to_id:
            existing_id = _key_to_id[key]
            state = _downloads[existing_id]
            with state._lock:
                if state.status in (DownloadStatus.queued, DownloadStatus.downloading):
                    return {"id": existing_id}
                if state.status == DownloadStatus.done:
                    return {"id": existing_id}
            # Remove the old error entry and re-queue
            del _key_to_id[key]
            del _downloads[existing_id]

        dl_id = str(uuid.uuid4())
        state = DownloadState(dl_id, req.repoId, req.filename, req.revision)
        _downloads[dl_id] = state
        _key_to_id[key] = dl_id

    thread = threading.Thread(target=_run_download, args=(state,), daemon=True)
    thread.start()

    return {"id": dl_id}


@app.get("/downloads")
def list_downloads() -> list:
    with _lock:
        states = list(_downloads.values())
    return [s.to_dict() for s in states]


@app.get("/health")
def health() -> dict:
    return {"ok": True}


if __name__ == "__main__":
    import uvicorn
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    uvicorn.run(app, host="0.0.0.0", port=PORT)
