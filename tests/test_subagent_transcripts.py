import base64
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(
    0,
    str(Path(__file__).resolve().parents[1] / "resources" / "transport-chat" / "scripts"),
)

from cursor_chat_io_bundle import (  # noqa: E402
    build_bundle,
    decode_artifact,
    iter_conversation_jsonl_files,
    sha256_hex,
)

CONV_ID = "aaa-bbb-ccc-ddd-eee-fff-00001111222233334444555566667777"
PROJECT_KEY = "home-user-dev-cursor-sync"


class TestSubagentTranscripts(unittest.TestCase):
    def test_iter_conversation_jsonl_files_includes_subagents(self):
        with tempfile.TemporaryDirectory() as td:
            conv_dir = Path(td) / CONV_ID
            sub_dir = conv_dir / "subagents"
            sub_dir.mkdir(parents=True)
            (conv_dir / f"{CONV_ID}.jsonl").write_text('{"role":"user"}\n', encoding="utf-8")
            (sub_dir / "sub-111.jsonl").write_text('{"role":"agent"}\n', encoding="utf-8")

            paths = iter_conversation_jsonl_files(conv_dir)
            rels = [p.relative_to(conv_dir).as_posix() for p in paths]

            self.assertEqual(
                rels,
                [f"{CONV_ID}.jsonl", "subagents/sub-111.jsonl"],
            )

    @mock.patch("cursor_chat_io_bundle.projects_root")
    def test_build_bundle_includes_subagent_jsonl(self, mock_projects_root):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            mock_projects_root.return_value = root
            conv_dir = root / PROJECT_KEY / "agent-transcripts" / CONV_ID
            sub_dir = conv_dir / "subagents"
            sub_dir.mkdir(parents=True)
            main_body = b'{"role":"user","message":{"content":[{"type":"text","text":"hello"}]}}\n'
            sub_body = b'{"role":"assistant","message":{"content":[{"type":"text","text":"sub"}]}}\n'
            (conv_dir / f"{CONV_ID}.jsonl").write_bytes(main_body)
            (sub_dir / "sub-111.jsonl").write_bytes(sub_body)

            bundle, _warnings = build_bundle(CONV_ID, None)
            rels = sorted(tf["relativePath"] for tf in bundle["transcriptFiles"])

            self.assertEqual(len(rels), 2)
            self.assertIn(
                f"{PROJECT_KEY}/agent-transcripts/{CONV_ID}/{CONV_ID}.jsonl",
                rels,
            )
            self.assertIn(
                f"{PROJECT_KEY}/agent-transcripts/{CONV_ID}/subagents/sub-111.jsonl",
                rels,
            )

    @mock.patch("cursor_chat_io_import.projects_root")
    @mock.patch("cursor_chat_io_bundle.projects_root")
    def test_import_writes_subagent_jsonl(self, mock_build_root, mock_import_root):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            mock_build_root.return_value = root
            mock_import_root.return_value = root
            conv_dir = root / PROJECT_KEY / "agent-transcripts" / CONV_ID
            sub_dir = conv_dir / "subagents"
            sub_dir.mkdir(parents=True)
            sub_body = b'{"role":"agent"}\n'
            (conv_dir / f"{CONV_ID}.jsonl").write_bytes(b'{"role":"user"}\n')
            (sub_dir / "sub-111.jsonl").write_bytes(sub_body)

            bundle, _warnings = build_bundle(CONV_ID, None)
            for path in list(conv_dir.rglob("*.jsonl")):
                path.unlink()
            sub_dir.rmdir()

            proot = root
            for tf in bundle["transcriptFiles"]:
                rel = tf["relativePath"]
                target = proot / rel
                raw = decode_artifact(tf["content"], tf.get("encoding"))
                self.assertEqual(sha256_hex(raw), tf.get("checksum"))
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(raw)

            sub_path = conv_dir / "subagents" / "sub-111.jsonl"
            self.assertTrue(sub_path.is_file())
            self.assertEqual(sub_path.read_bytes(), sub_body)


if __name__ == "__main__":
    unittest.main()
