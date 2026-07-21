import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

import main


class ValidationTests(unittest.TestCase):
    def test_repository_and_filename_are_jailed(self) -> None:
        self.assertEqual(main.validate_repo_id("owner/model"), "owner/model")
        self.assertEqual(main.validate_filename("weights/model.gguf"), "weights/model.gguf")
        for value in ("owner", "../owner/model", "owner/model/extra", "owner\\model"):
            with self.assertRaises(ValueError):
                main.validate_repo_id(value)
        for value in ("../model.gguf", "/model.gguf", "weights\\model.gguf", "./model.gguf"):
            with self.assertRaises(ValueError):
                main.validate_filename(value)

    def test_host_allowlist_requires_a_real_domain_boundary(self) -> None:
        self.assertTrue(main._download_host_allowed("https://huggingface.co/a/b"))
        self.assertTrue(main._download_host_allowed("https://cdn-lfs.hf.co/a"))
        self.assertFalse(main._download_host_allowed("https://evilhuggingface.co/a"))
        self.assertFalse(main._download_host_allowed("http://huggingface.co/a"))
        self.assertFalse(main._download_host_allowed("https://user@huggingface.co/a"))

    @patch("main.HfApi")
    def test_hub_lfs_dict_digest_is_enforced(self, api_type: Mock) -> None:
        digest = "a" * 64
        api_type.return_value.model_info.return_value = SimpleNamespace(
            sha="b" * 40,
            siblings=[
                SimpleNamespace(
                    rfilename="model.gguf",
                    size=123,
                    lfs={"sha256": digest},
                )
            ],
        )
        state = main.DownloadState("id", "owner/model", "model.gguf", None)
        self.assertEqual(main._metadata(state, None), ("b" * 40, digest, 123))
        state.expected_sha256 = "c" * 64
        with self.assertRaisesRegex(ValueError, "configured digest"):
            main._metadata(state, None)

    @patch("main.requests.get")
    def test_redirect_to_unapproved_host_is_not_followed(self, get: Mock) -> None:
        response = Mock(status_code=302, headers={"location": "http://127.0.0.1/secret"})
        get.return_value = response
        with self.assertRaisesRegex(ValueError, "unapproved"):
            main._stream_download("https://huggingface.co/owner/model", {})
        self.assertEqual(get.call_count, 1)
        response.close.assert_called_once()


if __name__ == "__main__":
    unittest.main()
