import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(
    0,
    str(Path(__file__).resolve().parents[1] / "resources" / "transport-chat" / "scripts"),
)

from cursor_chat_io import (  # noqa: E402
    ACTIVATION_PENDING_PATH,
    ACTIVATION_RESULT_PATH,
    WorkspaceContext,
    build_activation_manifest,
    invoke_composer_bridge,
    verify_activation_checks,
)

CID = "43aae2fb-71fc-4e9c-9add-3e995caaaa80"
WS_ID = "f038a5d2e2e5594b5e779064d4feac57"
WORKSPACE_IDENTIFIER = {
    "id": WS_ID,
    "uri": {
        "$mid": 1,
        "fsPath": "/home/user/proj",
        "_sep": 47,
        "external": "file:///home/user/proj",
        "path": "/home/user/proj",
        "scheme": "file",
    },
}


def _ws_ctx() -> WorkspaceContext:
    return WorkspaceContext(
        workspace_storage_id=WS_ID,
        folder_fs_path="/home/user/proj",
        chats_workspace_key="abc123",
        workspace_identifier=WORKSPACE_IDENTIFIER,
    )


class TestImportActivation(unittest.TestCase):
    def test_build_activation_manifest(self):
        bundle = {
            "conversationId": CID,
            "title": "Test chat",
            "sidebarSnapshot": {
                "composerHeaders": {
                    "allComposers": [
                        {
                            "type": "head",
                            "composerId": CID,
                            "name": "Test chat",
                            "unifiedMode": "agent",
                            "forceMode": "edit",
                            "createdAt": 1716283200000,
                            "lastUpdatedAt": 1716283200000,
                            "lastOpenedAt": 1716283200000,
                        }
                    ]
                },
            },
        }
        manifest = build_activation_manifest(bundle, CID, _ws_ctx())
        self.assertEqual(manifest["workspaceFolder"], "/home/user/proj")
        self.assertTrue(manifest["openInNewTab"])
        self.assertEqual(manifest["partialState"]["composerId"], CID)
        self.assertEqual(
            manifest["partialState"]["workspaceIdentifier"], WORKSPACE_IDENTIFIER
        )

    def test_invoke_composer_bridge_dry_run(self):
        manifest = {"partialState": {"composerId": CID}, "workspaceFolder": "/x"}
        code, cid = invoke_composer_bridge(manifest, dry_run=True)
        self.assertEqual(code, 0)
        self.assertEqual(cid, CID)

    @mock.patch("cursor_chat_io.subprocess.run")
    def test_invoke_composer_bridge_parses_stdout(self, run_mock):
        run_mock.return_value = mock.Mock(
            returncode=0,
            stdout='{"composerId":"' + CID + '"}\n',
            stderr="",
        )
        manifest = {
            "partialState": {"composerId": CID},
            "workspaceFolder": "/home/user/proj",
        }
        code, cid = invoke_composer_bridge(manifest)
        self.assertEqual(code, 0)
        self.assertEqual(cid, CID)
        run_mock.assert_called_once()

    def test_verify_activation_checks_pending_and_result(self):
        with tempfile.TemporaryDirectory() as tmp:
            act_dir = Path(tmp)
            pending = act_dir / "pending.json"
            result = act_dir / "result.json"
            pending.write_text(
                json.dumps({"composerId": CID, "version": 1}),
                encoding="utf-8",
            )
            result.write_text(
                json.dumps({"ok": True, "composerId": CID}),
                encoding="utf-8",
            )
            with (
                mock.patch("cursor_chat_io.ACTIVATION_PENDING_PATH", pending),
                mock.patch("cursor_chat_io.ACTIVATION_RESULT_PATH", result),
            ):
                checks = verify_activation_checks(CID)
            names = {c.name: c.status for c in checks}
            self.assertEqual(names["activation.pending"], "OK")
            self.assertEqual(names["activation.result"], "OK")
            self.assertEqual(names["activation.status"], "OK")


if __name__ == "__main__":
    unittest.main()
