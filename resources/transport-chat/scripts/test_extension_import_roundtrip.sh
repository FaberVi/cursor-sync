#!/usr/bin/env bash
# Chat import-v2 dual-path roundtrip (Cursor Sync extension + Python CLI).
#
# Same ChatBundle JSON is used for both paths so disk merge and activation signals
# are comparable. Path A is fully automatable; Path B requires Cursor with this
# workspace open and the Cursor Sync extension loaded (manual steps in checklist).
#
# Path A — Python CLI (headless-friendly)
#   scripts/test_import_roundtrip.sh  (or cursor_chat_io.py import/verify directly)
#   Stages ~/.cursor/import-activation/pending.json when --activate; extension watcher
#   or bridge may write result.json.
#
# Path B — Extension commands (in-IDE, preferred bridge when installed)
#   cursorSync.importChatBundle / cursorSync.importChatBundleActivate
#   cursorSync.verifyChatImport — disk + optional post-activate checks
#   See: .cursor/plans/chat-io-manual-test.md
#
# Exit criteria (activate runs): sidebar shows imported chat, verify all OK,
# result.json contains matching composerId. Checklist documents human checks.
#
# Usage:
#   ./scripts/test_extension_import_roundtrip.sh              # prepare bundle + CLI path
#   ./scripts/test_extension_import_roundtrip.sh prepare      # write bundle only
#   ./scripts/test_extension_import_roundtrip.sh cli          # CLI roundtrip (needs BUNDLE)
#   ./scripts/test_extension_import_roundtrip.sh extension    # print Path B steps
#   ./scripts/test_extension_import_roundtrip.sh --help
#
# Environment (shared by both paths):
#   WORKSPACE              Target workspace folder (default: repo root)
#   BUNDLE_PATH            Use existing bundle; else prepare under OUT_DIR
#   OUT_DIR                Default: REPO/.cursor/tmp/chat-io-roundtrip
#   DO_ACTIVATE            1|0 for CLI path (default 1)
#   KEEP_BUNDLE            1 keeps OUT_DIR bundle after exit (default 1)
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CLI_ROUNDTRIP="${SCRIPT_DIR}/test_import_roundtrip.sh"
CHECKLIST="${SKILL_ROOT}/docs/chat-import-activate.md"
WORKSPACE="${WORKSPACE:-${SKILL_ROOT}}"
OUT_DIR="${OUT_DIR:-${SKILL_ROOT}/.cursor/tmp/chat-io-roundtrip}"
DO_ACTIVATE="${DO_ACTIVATE:-1}"
KEEP_BUNDLE="${KEEP_BUNDLE:-1}"
MODE="${1:-all}"

log() { printf '%s\n' "$*" >&2; }
die() { log "error: $*"; exit 1; }

usage() {
  sed -n '2,36p' "$0" | sed 's/^# \{0,1\}//'
}

print_extension_path() {
  local bundle="$1"
  log ""
  log "=== Path B: Extension (manual, same bundle) ==="
  log "Checklist: ${CHECKLIST}"
  log "Bundle:    ${bundle}"
  log "Workspace: ${WORKSPACE}"
  log ""
  log "1. Open Cursor with workspace folder: ${WORKSPACE}"
  log "2. Confirm Cursor Sync extension is enabled (Developer: Show Running Extensions)."
  log "3. Command Palette:"
  if [[ "${DO_ACTIVATE}" == "1" ]]; then
    log "   - Cursor Sync: Import Chat Bundle (Activate)  (cursorSync.importChatBundleActivate)"
  else
    log "   - Cursor Sync: Import Chat Bundle  (cursorSync.importChatBundle)"
  fi
  log "   Select bundle: ${bundle}"
  log "4. Command Palette: Cursor Sync: Verify Chat Import  (cursorSync.verifyChatImport)"
  log "   Expect all checks OK in Output (cursorSync / Chat Import)."
  log "5. Exit criteria: see checklist (sidebar, tab hydrate, result.json if activate)."
  log ""
}

prepare_bundle() {
  mkdir -p "${OUT_DIR}"
  local out="${OUT_DIR}/roundtrip-bundle.json"
  if [[ -n "${BUNDLE_PATH:-}" && -f "${BUNDLE_PATH}" ]]; then
    log "Using existing BUNDLE_PATH=${BUNDLE_PATH}"
    printf '%s' "${BUNDLE_PATH}"
    return 0
  fi
  export REPO_ROOT
  export BUNDLE_PATH="${out}"
  log "Preparing fixture bundle at ${out}"
  python3 - "${out}" <<'PYIN'
import base64
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

root = Path(os.environ["SKILL_ROOT"])
sys.path.insert(0, str(root / "scripts"))
from cursor_chat_io import BUNDLE_TYPE, SCHEMA_VERSION, sha256_hex

out = Path(sys.argv[1])
fixture = root / "tests/fixtures/transcripts-bundle-v2"
sidebar = json.loads((fixture / "sidebar-snapshot.json").read_text(encoding="utf-8"))
sidebar.pop("composerData", None)
headers = sidebar.get("composerHeaders") or {}
allc = headers.get("allComposers") if isinstance(headers.get("allComposers"), list) else []
if allc and isinstance(allc[0], dict):
    h = dict(allc[0])
    h.setdefault("type", "head")
    h.setdefault("unifiedMode", "agent")
    h.setdefault("forceMode", "edit")
    for key in ("createdAt", "lastUpdatedAt", "lastOpenedAt"):
        if key not in h:
            h[key] = 1716283200000
    allc[0] = h
    headers["allComposers"] = allc
    sidebar["composerHeaders"] = headers
cid = "conversation-123"
for ent in (sidebar.get("composerHeaders") or {}).get("allComposers") or []:
    if isinstance(ent, dict) and ent.get("composerId"):
        cid = str(ent["composerId"])
        break
store_path = root / "resources/golden-chat-store.template.db"
raw = store_path.read_bytes()
store_snapshot = {
    "content": base64.b64encode(raw).decode("ascii"),
    "encoding": "base64",
    "checksum": sha256_hex(raw),
    "sizeBytes": len(raw),
    "sourceWorkspaceKey": "fixture",
}
transcript_files = []
jsonl = fixture / "conversation.jsonl"
if jsonl.is_file():
    tr = jsonl.read_bytes()
    transcript_files.append({
        "relativePath": f"fixture/agent-transcripts/{cid}/{jsonl.name}",
        "content": base64.b64encode(tr).decode("ascii"),
        "encoding": "base64",
        "checksum": sha256_hex(tr),
        "sizeBytes": len(tr),
    })
bundle = {
    "schemaVersion": SCHEMA_VERSION,
    "type": BUNDLE_TYPE,
    "createdAt": datetime.now(timezone.utc).isoformat(),
    "conversationId": cid,
    "title": "Extension roundtrip fixture",
    "subtitle": "dual-path test",
    "sidebarSnapshot": sidebar,
    "storeSnapshot": store_snapshot,
    "transcriptFiles": transcript_files,
}
out.write_text(json.dumps(bundle, indent=2), encoding="utf-8")
print(cid, file=sys.stderr)
PYIN
  export BUNDLE_PATH="${out}"
  printf '%s' "${out}"
}

run_cli_path() {
  local bundle="$1"
  [[ -x "${CLI_ROUNDTRIP}" ]] || chmod +x "${CLI_ROUNDTRIP}"
  log "=== Path A: Python CLI ==="
  log "Delegating to ${CLI_ROUNDTRIP}"
  export BUNDLE_PATH="${bundle}"
  export WORKSPACE
  export DO_ACTIVATE
  "${CLI_ROUNDTRIP}" "$@"
}

case "${MODE}" in
  -h|--help|help) usage; exit 0 ;;
  prepare)
    BUNDLE="$(prepare_bundle)"
    log "Prepared bundle: ${BUNDLE}"
    print_extension_path "${BUNDLE}"
    exit 0
    ;;
  cli)
    BUNDLE="${BUNDLE_PATH:-}"
    [[ -n "${BUNDLE}" && -f "${BUNDLE}" ]] || BUNDLE="$(prepare_bundle)"
    run_cli_path "${BUNDLE}"
    print_extension_path "${BUNDLE}"
    exit 0
    ;;
  extension)
    BUNDLE="${BUNDLE_PATH:-}"
    [[ -n "${BUNDLE}" && -f "${BUNDLE}" ]] || BUNDLE="$(prepare_bundle)"
    print_extension_path "${BUNDLE}"
    exit 0
    ;;
  all)
    BUNDLE="$(prepare_bundle)"
    run_cli_path "${BUNDLE}" || log "CLI path skipped or SKIP (see stderr)"
    print_extension_path "${BUNDLE}"
    if [[ "${KEEP_BUNDLE}" != "1" ]]; then
      log "Removing ${OUT_DIR} (KEEP_BUNDLE!=1)"
      rm -rf "${OUT_DIR}"
    else
      log "Kept bundle at ${BUNDLE}"
    fi
    exit 0
    ;;
  *)
    die "unknown mode: ${MODE} (try --help)"
    ;;
esac
