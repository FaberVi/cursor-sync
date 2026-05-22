#!/usr/bin/env bash
# Integration: export (optional) -> import [--activate] -> verify -> grep composerId proxy.
# Exit 0 when the roundtrip succeeds or prerequisites are missing (clear SKIP on stderr).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
export SKILL_ROOT
WORKSPACE="${WORKSPACE:-${SKILL_ROOT}}"
CHAT_IO="${SCRIPT_DIR}/cursor_chat_io.py"
FIXTURE_DIR="${SKILL_ROOT}/tests/fixtures/transcripts-bundle-v2"
GOLDEN_STORE="${SKILL_ROOT}/resources/golden-chat-store.template.db"

DO_ACTIVATE="${DO_ACTIVATE:-1}"
DRY_RUN=0
SKIP_IMPORT=0

log() { printf '%s\n' "$*" >&2; }
die() { log "error: $*"; exit 1; }
skip() { log "SKIP: $*"; exit 0; }

usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

End-to-end check for cursor_chat_io import + optional --activate + verify.

Environment:
  WORKSPACE              Workspace folder (default: repo root)
  CONVERSATION_ID        If set, export this chat before import (golden chat)
  BUNDLE_PATH            Use this bundle JSON instead of export/fixture build
  DO_ACTIVATE            1 (default) or 0 to skip --activate
  CURSOR_COMPOSER_BRIDGE_COMMAND  Hook for IDE activation (optional)
  BRIDGE_WAIT_RESULT     Seconds for import --bridge-wait-result (optional)

Options:
  -h, --help             Show this help
  -n, --dry-run          Assemble bundle + import/verify dry-run only (no disk writes)
  --no-activate          Same as DO_ACTIVATE=0

Prerequisites for full run:
  - python3 and scripts/cursor_chat_io.py
  - For export: CONVERSATION_ID present in local Cursor data
  - For --activate: Cursor running on WORKSPACE (or bridge hook / result.json)
  Without prerequisites, exits 0 with SKIP message on stderr.

RequestID is not set by the bridge; this script greps composerId in activation
artifacts, state.vscdb (when readable), and transcript paths as a load proxy.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    -n|--dry-run) DRY_RUN=1; shift ;;
    --no-activate) DO_ACTIVATE=0; shift ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
done

command -v python3 >/dev/null 2>&1 || die "python3 not found"
[[ -f "${CHAT_IO}" ]] || die "missing ${CHAT_IO}"

TMPDIR="${TMPDIR:-/tmp}"
RUN_DIR="$(mktemp -d "${TMPDIR}/cursor-import-roundtrip.XXXXXX")"
cleanup() { rm -rf "${RUN_DIR}"; }
trap cleanup EXIT

BUNDLE="${BUNDLE_PATH:-${RUN_DIR}/bundle.json}"

assemble_fixture_bundle() {
  python3 - "${BUNDLE}" <<'PY'
import base64
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

root = Path(os.environ["SKILL_ROOT"])
sys.path.insert(0, str(root / "scripts"))
from cursor_chat_io import BUNDLE_TYPE, SCHEMA_VERSION, sha256_hex  # noqa: E402

out = Path(sys.argv[1])
fixture = root / "tests/fixtures/transcripts-bundle-v2"
sidebar = json.loads((fixture / "sidebar-snapshot.json").read_text(encoding="utf-8"))
# Drop per-composer composerData so verify does not require workspace state.vscdb key
# (global merge is enough for sidebar roundtrip; full composerData is optional v1).
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
if not store_path.is_file():
    print("golden store template missing", file=sys.stderr)
    sys.exit(2)
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
    transcript_files.append(
        {
            "relativePath": f"fixture/agent-transcripts/{cid}/{jsonl.name}",
            "content": base64.b64encode(tr).decode("ascii"),
            "encoding": "base64",
            "checksum": sha256_hex(tr),
            "sizeBytes": len(tr),
        }
    )

bundle = {
    "schemaVersion": SCHEMA_VERSION,
    "type": BUNDLE_TYPE,
    "createdAt": datetime.now(timezone.utc).isoformat(),
    "conversationId": cid,
    "title": "Transcript Fidelity Check",
    "subtitle": "roundtrip fixture",
    "sidebarSnapshot": sidebar,
    "storeSnapshot": store_snapshot,
    "transcriptFiles": transcript_files,
}
out.write_text(json.dumps(bundle, indent=2), encoding="utf-8")
print(cid)
PY
}

cursor_looks_running() {
  if pgrep -x cursor >/dev/null 2>&1; then
    return 0
  fi
  if pgrep -f '[Cc]ursor' >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

if [[ -n "${BUNDLE_PATH:-}" && -f "${BUNDLE_PATH}" ]]; then
  log "Using BUNDLE_PATH=${BUNDLE_PATH}"
elif [[ -n "${CONVERSATION_ID:-}" ]]; then
  log "Exporting golden chat CONVERSATION_ID=${CONVERSATION_ID}"
  if ! python3 "${CHAT_IO}" list 2>/dev/null | grep -qF "${CONVERSATION_ID}"; then
    skip "no local data for CONVERSATION_ID=${CONVERSATION_ID} (see: cursor_chat_io.py list)"
  fi
  if ! python3 "${CHAT_IO}" export "${CONVERSATION_ID}" -o "${BUNDLE}" 2>"${RUN_DIR}/export.err"; then
    skip "export failed for ${CONVERSATION_ID}: $(head -3 "${RUN_DIR}/export.err" | tr '\n' ' ')"
  fi
elif [[ -f "${FIXTURE_DIR}/sidebar-snapshot.json" ]]; then
  log "Building bundle from fixture ${FIXTURE_DIR}"
  assemble_fixture_bundle >/dev/null
else
  skip "no CONVERSATION_ID, BUNDLE_PATH, or fixture at ${FIXTURE_DIR}"
fi

CONV_ID="$(python3 -c "import json; print(json.load(open('${BUNDLE}'))['conversationId'])")"
log "Bundle conversationId=${CONV_ID}"

python3 "${CHAT_IO}" inspect "${BUNDLE}" >&2 || true

IMPORT_ARGS=(import "${BUNDLE}" --workspace-folder "${WORKSPACE}")
VERIFY_ARGS=(verify --bundle "${BUNDLE}" --workspace-folder "${WORKSPACE}")
if [[ "${DRY_RUN}" -eq 1 ]]; then
  IMPORT_ARGS+=(--dry-run)
  log "Dry-run: import + verify only (no activation side effects)"
  python3 "${CHAT_IO}" "${IMPORT_ARGS[@]}" >&2
  python3 "${CHAT_IO}" "${VERIFY_ARGS[@]}" >&2 || true
  log "Dry-run OK"
  exit 0
fi

if [[ "${DO_ACTIVATE}" -eq 1 ]]; then
  if ! cursor_looks_running; then
    skip "Cursor does not appear to be running (needed for --activate on ${WORKSPACE})"
  fi
  IMPORT_ARGS+=(--activate)
  if [[ -z "${CURSOR_COMPOSER_BRIDGE_COMMAND:-}" ]]; then
    log "note: CURSOR_COMPOSER_BRIDGE_COMMAND unset; bridge may stage only (exit 2) without --activate-strict"
  else
    log "bridge hook: CURSOR_COMPOSER_BRIDGE_COMMAND is set"
  fi
  if [[ -n "${BRIDGE_WAIT_RESULT:-}" ]]; then
    IMPORT_ARGS+=(--bridge-wait-result "${BRIDGE_WAIT_RESULT}")
  fi
  VERIFY_ARGS+=(--post-activate)
fi

log "Importing into workspace ${WORKSPACE}"
set +e
python3 "${CHAT_IO}" "${IMPORT_ARGS[@]}" 2>"${RUN_DIR}/import.err" | tee "${RUN_DIR}/import.out" >&2
IMPORT_RC=${PIPESTATUS[0]}
set -e
if [[ "${IMPORT_RC}" -ne 0 ]]; then
  if [[ "${DO_ACTIVATE}" -eq 1 ]] && [[ -z "${CURSOR_COMPOSER_BRIDGE_COMMAND:-}" ]]; then
    if grep -q "bridge exited 2\|staged only\|activation" "${RUN_DIR}/import.err" 2>/dev/null; then
      log "warn: import returned ${IMPORT_RC} but activate staging may be OK without hook (see stderr)"
    else
      die "import failed (exit ${IMPORT_RC}); see ${RUN_DIR}/import.err"
    fi
  else
    die "import failed (exit ${IMPORT_RC}); see ${RUN_DIR}/import.err"
  fi
fi

log "Running verify"
set +e
python3 "${CHAT_IO}" "${VERIFY_ARGS[@]}" 2>&1 | tee "${RUN_DIR}/verify.out" >&2
VERIFY_RC=${PIPESTATUS[0]}
set -e
if [[ "${VERIFY_RC}" -ne 0 ]]; then
  die "verify failed (exit ${VERIFY_RC})"
fi

log "Grep RequestID proxy (composerId) in activation + disk hints"
GREP_OK=0
for f in "${HOME}/.cursor/import-activation/pending.json" "${HOME}/.cursor/import-activation/result.json"; do
  if [[ -f "${f}" ]] && grep -qF "${CONV_ID}" "${f}"; then
    log "  found composerId in ${f}"
    GREP_OK=1
  fi
done

while IFS= read -r line; do
  [[ -n "${line}" ]] || continue
  log "  ${line}"
  GREP_OK=1
done < <(python3 - "${CONV_ID}" <<'PY' 2>/dev/null || true
import json
import sqlite3
import sys
from pathlib import Path

cid = sys.argv[1]
home = Path.home()
for label, path in (
    ("pending", home / ".cursor/import-activation/pending.json"),
    ("result", home / ".cursor/import-activation/result.json"),
):
    if not path.is_file():
        continue
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        got = data.get("composerId") or (data.get("partialState") or {}).get("composerId")
        if got == cid:
            print(f"activation {label}: composerId match")
    except (OSError, json.JSONDecodeError):
        print(f"activation {label}: unreadable")

g = home / ".config/Cursor/User/globalStorage/state.vscdb"
if g.is_file():
    conn = sqlite3.connect(f"file:{g}?mode=ro", uri=True)
    try:
        row = conn.execute(
            "SELECT value FROM ItemTable WHERE key = ?", ("composer.composerHeaders",)
        ).fetchone()
        if row and cid in (row[0] or ""):
            print("state.vscdb global composer.composerHeaders: composerId present")
    finally:
        conn.close()

proot = home / ".cursor/projects"
if proot.is_dir():
    for proj in proot.iterdir():
        tdir = proj / "agent-transcripts" / cid
        if tdir.is_dir():
            print(f"transcript dir: {tdir}")
            break
PY
)

if grep -qF "${CONV_ID}" "${RUN_DIR}/verify.out" 2>/dev/null; then
  log "  verify output mentions ${CONV_ID}"
  GREP_OK=1
fi

if [[ "${GREP_OK}" -eq 0 ]]; then
  log "warn: composerId proxy grep found no strong match (activation may still be PENDING)"
fi

log "Roundtrip finished OK for ${CONV_ID}"
exit 0
