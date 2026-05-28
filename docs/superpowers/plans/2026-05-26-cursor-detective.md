# cursor-detective Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a personal read-only skill at `~/.cursor/skills/cursor-detective/` that runs bundled bash probes against Cursor install/config/SQLite/workbench artifacts and writes `.cursor/plans/detective-<theme>.plan.md` in the current workspace when the user invokes `/cursor-detective [theme]`.

**Architecture:** `SKILL.md` orchestrates five phases (Frame → Discover → Delegate → Extract → Synthesize) and mandates the evidence model (Confirmed / Inferred / Unknown). Seven read-only scripts under `scripts/` emit JSON-ish key=value blocks for agent citation; `reference.md` holds path tables and chat-layer examples (not playbooks). `disable-model-invocation: true` prevents auto-invocation.

**Tech Stack:** Bash (`set -euo pipefail`), `sqlite3` CLI (read-only URI mode), `grep`/`find`/`stat`, optional parallel subagents per SKILL.md. No Python dependency (unlike transport-chat). Install and smoke tests run on the host Linux machine; macOS/Windows path branches return structured “not probed” markers in v1.

**Spec:** [docs/superpowers/specs/2026-05-25-cursor-detective-design.md](../specs/2026-05-25-cursor-detective-design.md)

**Out of scope for this plan:** cursor-sync repo commits, project-scoped `.cursor/skills/` copy, playbooks, fixes/export.

---

## File map

| Path | Responsibility |
|------|----------------|
| `~/.cursor/skills/cursor-detective/SKILL.md` | Frontmatter, pipeline phases, delegation table, evidence rules, report template |
| `~/.cursor/skills/cursor-detective/reference.md` | OS path table, SQLite notes, workbench grep keywords, four-layer chat examples |
| `~/.cursor/skills/cursor-detective/scripts/_lib.sh` | Shared path helpers, JSON-ish printers, truncation header |
| `~/.cursor/skills/cursor-detective/scripts/locate-cursor.sh` | Install roots, AppImage, `WORKBENCH_JS` |
| `~/.cursor/skills/cursor-detective/scripts/scan-paths.sh` | Exists/size/mtime inventory |
| `~/.cursor/skills/cursor-detective/scripts/inspect-state-vscdb.sh` | `ItemTable` + `cursorDiskKV` sampling |
| `~/.cursor/skills/cursor-detective/scripts/inspect-store-db.sh` | `store.db` schema/meta/blob counts |
| `~/.cursor/skills/cursor-detective/scripts/grep-workbench.sh` | Minified bundle keyword search |
| `~/.cursor/skills/cursor-detective/scripts/compare-sqlite-meta.sh` | Schema + row-count diff |
| `~/.cursor/skills/cursor-detective/scripts/compare-dirs.sh` | Shallow directory diff |
| `~/.cursor/skills/cursor-detective/tests/smoke.sh` | Fixture-based exit-code checks (not committed to cursor-sync) |

---

## Locked implementation choices (spec open questions)

| Question | Decision |
|----------|----------|
| `inspect-state-vscdb.sh` default DB | Global `globalStorage/state.vscdb`; also accept `--db PATH` and `--workspace-storage-id HASH` (resolves under `workspaceStorage/<id>/state.vscdb`) |
| `locate-cursor.sh` cross-platform | v1: full Linux search list; macOS/Windows emit `probe_status=skipped` plus canonical paths from `reference.md` (tag **Unknown** in report, not silent omission) |

---

### Task 1: Scaffold skill directory

**Files:**
- Create: `~/.cursor/skills/cursor-detective/scripts/` (empty)
- Create: `~/.cursor/skills/cursor-detective/tests/`

- [ ] **Step 1: Create directories**

```bash
mkdir -p ~/.cursor/skills/cursor-detective/{scripts,tests}
```

- [ ] **Step 2: Verify layout**

```bash
test -d ~/.cursor/skills/cursor-detective/scripts
test -d ~/.cursor/skills/cursor-detective/tests
echo OK
```

Expected: `OK`

---

### Task 2: Shared library `_lib.sh`

**Files:**
- Create: `~/.cursor/skills/cursor-detective/scripts/_lib.sh`

- [ ] **Step 1: Write `_lib.sh`**

```bash
#!/usr/bin/env bash
# shellcheck disable=SC2034
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"

emit_header() {
  local script="$1"
  local note="${2:-}"
  echo "script=${script}"
  echo "timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if [[ -n "$note" ]]; then
    echo "note=${note}"
  fi
}

kv() { printf '%s=%s\n' "$1" "$2"; }

die() {
  echo "error: $*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

human_bytes() {
  local n="$1"
  if (( n < 1024 )); then echo "${n}B"; return; fi
  if (( n < 1048576 )); then echo "$(( n / 1024 ))KB"; return; fi
  echo "$(( n / 1048576 ))MB"
}

path_stat_line() {
  local label="$1"
  local p="$2"
  if [[ -e "$p" ]]; then
    local sz mt
    sz=$(stat -c '%s' "$p" 2>/dev/null || stat -f '%z' "$p")
    mt=$(stat -c '%y' "$p" 2>/dev/null || stat -f '%Sm' "$p")
    kv "${label}_exists" "true"
    kv "${label}_path" "$p"
    kv "${label}_size" "$(human_bytes "$sz")"
    kv "${label}_mtime" "$mt"
  else
    kv "${label}_exists" "false"
    kv "${label}_path" "$p"
  fi
}

cursor_config_root() {
  local home sys
  home="${HOME}"
  sys="$(uname -s)"
  case "$sys" in
    Darwin) echo "${home}/Library/Application Support/Cursor/User" ;;
    MINGW*|MSYS*|CYGWIN*)
      local appdata="${APPDATA:-${home}/AppData/Roaming}"
      echo "${appdata}/Cursor/User"
      ;;
    *) echo "${home}/.config/Cursor/User" ;;
  esac
}

projects_root() { echo "${HOME}/.cursor/projects"; }
chats_root() { echo "${HOME}/.cursor/chats"; }

global_state_db() {
  echo "$(cursor_config_root)/globalStorage/state.vscdb"
}

workspace_state_db() {
  local id="$1"
  echo "$(cursor_config_root)/workspaceStorage/${id}/state.vscdb"
}

normalize_theme() {
  local raw="${1:-}"
  raw="$(echo "$raw" | tr '[:upper:]' '[:lower:]' | tr ' _' '-')"
  raw="$(echo "$raw" | sed -E 's/[^a-z0-9-]+//g; s/-+/-/g; s/^-|-$//g')"
  if [[ -z "$raw" ]]; then raw="general-scan"; fi
  echo "$raw"
}

TRUNCATE_MAX="${TRUNCATE_MAX:-20}"
```

- [ ] **Step 2: Smoke-source library**

```bash
# shellcheck source=/dev/null
source ~/.cursor/skills/cursor-detective/scripts/_lib.sh
[[ "$(normalize_theme '  Cursor Storage  ')" == "cursor-storage" ]]
echo OK
```

Expected: `OK`

---

### Task 3: `SKILL.md` orchestrator

**Files:**
- Create: `~/.cursor/skills/cursor-detective/SKILL.md`

- [ ] **Step 1: Write `SKILL.md`**

Use this file verbatim (adjust only if Cursor frontmatter limits change):

```markdown
---
name: cursor-detective
description: >-
  Deep read-only forensics on Cursor local install, config, SQLite state,
  workbench bundles, and project artifacts via bundled scripts and parallel
  probes. Writes .cursor/plans/detective-<theme>.plan.md. Use when the user
  invokes /cursor-detective or asks to reverse-engineer Cursor internals,
  scan state.vscdb, inspect AppImage/workbench, or compare on-disk behavior.
disable-model-invocation: true
---

# cursor-detective

Read-only investigation skill. **Do not modify** `~/.cursor`, `~/.config/Cursor`, or install trees except writing the report under the **current workspace**.

## Invocation

`/cursor-detective [theme]`

If theme is empty, use `general-scan`.

## Theme normalization

Same rules as unravel: trim, lowercase, spaces/underscores → `-`, strip non `[a-z0-9-]`, collapse `-`, fallback `general-scan`.

Output file: `.cursor/plans/detective-<theme>.plan.md` (create `.cursor/plans/` if missing).

## Pipeline

### Phase 1 — Frame

1. Normalize theme.
2. Set `PLAN_PATH=".cursor/plans/detective-<theme>.plan.md"`.
3. One paragraph: objective, scope, success criteria.
4. Bullet testable assumptions and unknowns.

### Phase 2 — Discover (scripts, in order)

Run from `~/.cursor/skills/cursor-detective/scripts/`:

1. `./locate-cursor.sh`
2. `./scan-paths.sh`

If a script exits non-zero, record exit code in the plan and continue only when the failure is non-fatal (missing install); stop if `sqlite3` is missing and DB scripts are required.

### Phase 3 — Delegate (optional)

When theme is broad (`general-scan`, `cursor-storage-inventory`) or user gave compare targets, launch up to four parallel subagents:

| Agent | Scope |
|-------|--------|
| Install/bundle | AppImage/squashfs, `workbench.desktop.main.js`, `grep-workbench.sh` defaults |
| State DBs | `inspect-state-vscdb.sh` global + latest workspace DB |
| Project artifacts | `~/.cursor/projects/**`, transcripts, `inspect-store-db.sh` on a sample `store.db` |
| Compare | User UUIDs/paths: `compare-dirs.sh` / `compare-sqlite-meta.sh` |

Subagents must paste script output; tag every finding.

### Phase 4 — Extract (by theme)

| Theme signal | Scripts |
|--------------|---------|
| persistence, storage, vscdb, composer | `inspect-state-vscdb.sh`, `inspect-store-db.sh` |
| UI, composer, sidebar, workbench | `grep-workbench.sh` |
| compare, diff, broken vs working | `compare-dirs.sh`, `compare-sqlite-meta.sh` |
| inventory / general | all inspect scripts with default limits |

### Phase 5 — Synthesize

Write `PLAN_PATH` using **Report template** below. Run scripts **before** any **Confirmed** finding.

## Evidence model

| Tag | Use when |
|-----|----------|
| **Confirmed** | Script stdout or cited path + snippet |
| **Inferred** | Pattern in bundle/DB without runtime proof |
| **Unknown** | Probe ran; no evidence; say what was tried |

Forbidden: inventing keys, APIs, or paths not seen in probes.

## Report template (required section order)

1. **Objective**
2. **Environment** (OS; `locate-cursor.sh`; version/channel if detected)
3. **Scan checklist** (table: script, exit code, one-line result)
4. **Findings** (by subsystem; tagged bullets)
5. **Diagram** (mermaid, when persistence/UI flow in scope)
6. **Gaps & follow-ups**
7. **Workspace relevance** (optional; e.g. cursor-sync transport)

## Script index

| Script | Purpose |
|--------|---------|
| `locate-cursor.sh` | Install + `WORKBENCH_JS` |
| `scan-paths.sh` | Standard data dir inventory |
| `inspect-state-vscdb.sh` | `--db`, `--workspace-storage-id`, `--composer-id` |
| `inspect-store-db.sh` | `--db PATH` |
| `grep-workbench.sh` | `--pattern`, `--file`, or built-ins |
| `compare-sqlite-meta.sh` | `--a` `--b` |
| `compare-dirs.sh` | `--a` `--b` |

See [reference.md](reference.md) for paths and chat-layer examples.

## Related skills

| Skill | Use instead when |
|-------|------------------|
| transport-chat / Cursor Sync Chats | export/import transport |
| unravel | flow narrative only |
| research | open-repo code, not Cursor product |
| debugger | repro + fix |
```

- [ ] **Step 2: Confirm frontmatter parses**

```bash
head -n 8 ~/.cursor/skills/cursor-detective/SKILL.md | grep -E '^name:|^disable-model-invocation:'
```

Expected: both lines present.

---

### Task 4: `reference.md`

**Files:**
- Create: `~/.cursor/skills/cursor-detective/reference.md`

- [ ] **Step 1: Write `reference.md`**

Include these sections (full prose, not stubs):

1. **Platform paths** — table: Linux / macOS / Windows for `User/`, `globalStorage/state.vscdb`, `workspaceStorage/`, `~/.cursor/projects/`, `~/.cursor/chats/`, `~/.cursor/import-activation/`.
2. **`state.vscdb`** — `ItemTable` (`composer.composerHeaders`, `composer.composerData`) vs `cursorDiskKV` (`composerData:<uuid>`, `bubbleId:<uuid>:*`).
3. **Workbench** — typical relative path `resources/app/out/vs/workbench/workbench.desktop.main.js` under install root; AppImage mount notes for Linux.
4. **Examples (not playbooks)** — four layers from transport-chat: transcripts, `store.db`, sidebar `state.vscdb`, IDE activation; note IDE reads `cursorDiskKV` for bubble UI; `store.db` often CLI-side; JSONL archival.
5. **`grep-workbench.sh` defaults** — `toolFormerData`, `composerData`, `cursorDiskKV`, `store.db`, `composer.composerHeaders`, `createComposer`.
6. **cursor-sync cross-link** — when workspace is [cursor-sync](https://github.com/Marcelo-Barella/cursor-sync): `resources/transport-chat/reference.md`, `docs/chat-import-activate.md`.

- [ ] **Step 2: Link check (local paths exist in repo when developing from cursor-sync)**

```bash
test -f /home/marcelo/dev/private/cursor-sync/docs/chat-import-activate.md
test -f /home/marcelo/dev/private/cursor-sync/resources/transport-chat/reference.md
echo OK
```

Expected: `OK`

---

### Task 5: `locate-cursor.sh`

**Files:**
- Create: `~/.cursor/skills/cursor-detective/scripts/locate-cursor.sh`

- [ ] **Step 1: Write script**

```bash
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/_lib.sh
source "${SCRIPT_DIR}/_lib.sh"

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

[[ "${1:-}" == "--help" || "${1:-}" == "-h" ]] && usage

emit_header "locate-cursor.sh"

sys="$(uname -s)"
kv "platform" "$sys"

search_roots=()
case "$sys" in
  Linux)
    search_roots+=(
      "${HOME}/Applications/cursor"
      "/usr/share/cursor"
      "/usr/share/cursor/resources"
      "/opt/Cursor"
      "${HOME}/.local/share/cursor"
      "${HOME}/.local/share/Cursor"
    )
    ;;
  Darwin)
    kv "probe_status" "skipped"
    kv "probe_note" "macOS install search not implemented in v1; paths listed in reference.md"
    search_roots+=("/Applications/Cursor.app/Contents")
    ;;
  *)
    kv "probe_status" "skipped"
    kv "probe_note" "Windows install search not implemented in v1"
    ;;
esac

best_install=""
best_workbench=""

for root in "${search_roots[@]}"; do
  [[ -d "$root" ]] || continue
  kv "candidate_install" "$root"
  wb="$(find "$root" -type f -name 'workbench.desktop.main.js' 2>/dev/null | head -n 1 || true)"
  if [[ -n "$wb" && -f "$wb" ]]; then
    best_install="$root"
    best_workbench="$wb"
    break
  fi
done

# AppImage heuristic (Linux)
if [[ "$sys" == "Linux" && -z "$best_workbench" ]]; then
  while IFS= read -r -d '' img; do
    kv "appimage_candidate" "$img"
  done < <(find "${HOME}" -maxdepth 4 -type f -name 'cursor*.AppImage' -print0 2>/dev/null || true)
fi

if [[ -n "$best_workbench" ]]; then
  kv "INSTALL_ROOT" "$best_install"
  kv "WORKBENCH_JS" "$best_workbench"
  kv "workbench_size" "$(human_bytes "$(stat -c '%s' "$best_workbench" 2>/dev/null || stat -f '%z' "$best_workbench")")"
else
  kv "WORKBENCH_JS" ""
  kv "install_status" "not_found"
fi

# Version hint from product.json when present
if [[ -n "$best_install" ]]; then
  pj="$(find "$best_install" -type f -path '*/resources/app/product.json' 2>/dev/null | head -n 1 || true)"
  if [[ -f "${pj:-}" ]]; then
    ver="$(grep -E '"version"' "$pj" | head -n 1 | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')"
    kv "cursor_version" "${ver:-unknown}"
  fi
fi
```

```bash
chmod +x ~/.cursor/skills/cursor-detective/scripts/locate-cursor.sh
```

- [ ] **Step 2: Run (may report not_found on CI)**

```bash
~/.cursor/skills/cursor-detective/scripts/locate-cursor.sh | head -n 15
echo exit=$?
```

Expected: exit `0`; `script=locate-cursor.sh` in output.

---

### Task 6: `scan-paths.sh`

**Files:**
- Create: `~/.cursor/skills/cursor-detective/scripts/scan-paths.sh`

- [ ] **Step 1: Write script**

```bash
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_lib.sh"

[[ "${1:-}" == "--help" || "${1:-}" == "-h" ]] && { sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0; }

emit_header "scan-paths.sh"

cfg="$(cursor_config_root)"
path_stat_line "cursor_user_config" "$cfg"
path_stat_line "global_state_vscdb" "$(global_state_db)"
path_stat_line "projects_root" "$(projects_root)"
path_stat_line "chats_root" "$(chats_root)"

ws_root="${cfg}/workspaceStorage"
if [[ -d "$ws_root" ]]; then
  count=0
  while IFS= read -r d; do
  [[ -z "$d" ]] && continue
  kv "workspace_storage_dir" "$d"
  path_stat_line "workspace_state" "${d}/state.vscdb"
  count=$((count + 1))
  [[ "$count" -ge 5 ]] && { kv "workspace_storage_truncated" "true"; break; }
  done < <(find "$ws_root" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort | head -n 6)
fi

pr="$(projects_root)"
if [[ -d "$pr" ]]; then
  kv "projects_count" "$(find "$pr" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')"
fi

cr="$(chats_root)"
if [[ -d "$cr" ]]; then
  kv "chats_workspace_keys" "$(find "$cr" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')"
fi
```

```bash
chmod +x ~/.cursor/skills/cursor-detective/scripts/scan-paths.sh
```

- [ ] **Step 2: Run**

```bash
~/.cursor/skills/cursor-detective/scripts/scan-paths.sh | head -n 20
```

Expected: exit `0`; lines for `global_state_vscdb_*` or `exists=false`.

---

### Task 7: `inspect-state-vscdb.sh`

**Files:**
- Create: `~/.cursor/skills/cursor-detective/scripts/inspect-state-vscdb.sh`

- [ ] **Step 1: Write failing smoke expectation** (add to `tests/smoke.sh` in Task 12 — here define behavior)

Script must:
- `require_cmd sqlite3`
- Resolve DB: `--db PATH` > `--workspace-storage-id ID` > global default
- Open `file:...?mode=ro`
- Print table list; counts `ItemTable` keys matching `composer.%`; prefix histogram for `cursorDiskKV` (top 10 prefixes); with `--composer-id UUID` list matching `composerData:` / `bubbleId:` key counts

- [ ] **Step 2: Write script**

```bash
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_lib.sh"

DB=""
WS_ID=""
COMPOSER_ID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --db) DB="$2"; shift 2 ;;
    --workspace-storage-id) WS_ID="$2"; shift 2 ;;
    --composer-id) COMPOSER_ID="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: inspect-state-vscdb.sh [--db PATH] [--workspace-storage-id ID] [--composer-id UUID]"
      exit 0 ;;
    *) die "unknown arg: $1" ;;
  esac
done

require_cmd sqlite3

if [[ -n "$WS_ID" ]]; then
  DB="$(workspace_state_db "$WS_ID")"
elif [[ -z "$DB" ]]; then
  DB="$(global_state_db)"
fi

[[ -f "$DB" ]] || die "state.vscdb not found: $DB"

emit_header "inspect-state-vscdb.sh" "read-only"
kv "db" "$DB"

sqlite3 "file:${DB}?mode=ro" <<'SQL'
.headers off
.mode list
SELECT 'table=' || name FROM sqlite_master WHERE type='table' ORDER BY 1;
SQL

composer_keys="$(sqlite3 "file:${DB}?mode=ro" "SELECT COUNT(*) FROM ItemTable WHERE key LIKE 'composer.%';" 2>/dev/null || echo 0)"
kv "itemtable_composer_key_count" "$composer_keys"

sqlite3 "file:${DB}?mode=ro" <<'SQL' || true
.headers on
.mode csv
SELECT key, length(value) AS value_len FROM ItemTable WHERE key LIKE 'composer.%' LIMIT 10;
SQL

kv "cursorDiskKV_total" "$(sqlite3 "file:${DB}?mode=ro" "SELECT COUNT(*) FROM cursorDiskKV;" 2>/dev/null || echo 0)"

sqlite3 "file:${DB}?mode=ro" <<'SQL' || true
.headers on
.mode csv
SELECT substr(key,1,instr(key||':',':')-1) AS prefix, COUNT(*) AS n
FROM cursorDiskKV
GROUP BY 1
ORDER BY n DESC
LIMIT 10;
SQL

if [[ -n "$COMPOSER_ID" ]]; then
  kv "composer_id" "$COMPOSER_ID"
  n="$(sqlite3 "file:${DB}?mode=ro" "SELECT COUNT(*) FROM cursorDiskKV WHERE key LIKE 'bubbleId:${COMPOSER_ID}:%';")"
  kv "bubble_keys_for_composer" "$n"
  sqlite3 "file:${DB}?mode=ro" "SELECT key FROM cursorDiskKV WHERE key='composerData:${COMPOSER_ID}' OR key LIKE 'bubbleId:${COMPOSER_ID}:%' LIMIT 5;"
fi
```

```bash
chmod +x ~/.cursor/skills/cursor-detective/scripts/inspect-state-vscdb.sh
```

- [ ] **Step 3: Run against global DB if present**

```bash
~/.cursor/skills/cursor-detective/scripts/inspect-state-vscdb.sh 2>&1 | head -n 25 || true
```

Expected: exit `0` when `~/.config/Cursor/User/globalStorage/state.vscdb` exists; non-zero with clear stderr when missing.

---

### Task 8: `inspect-store-db.sh`

**Files:**
- Create: `~/.cursor/skills/cursor-detective/scripts/inspect-store-db.sh`

- [ ] **Step 1: Write script**

```bash
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_lib.sh"

DB=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --db) DB="$2"; shift 2 ;;
    -h|--help) echo "Usage: inspect-store-db.sh --db PATH"; exit 0 ;;
    *) die "unknown arg: $1" ;;
  esac
done

[[ -n "$DB" ]] || die "--db PATH required"
[[ -f "$DB" ]] || die "store.db not found: $DB"
require_cmd sqlite3

emit_header "inspect-store-db.sh"
kv "db" "$DB"

sqlite3 "file:${DB}?mode=ro" ".schema"

if sqlite3 "file:${DB}?mode=ro" "SELECT name FROM sqlite_master WHERE type='table' AND name='meta';" | grep -q meta; then
  kv "meta_table" "present"
  sqlite3 "file:${DB}?mode=ro" "SELECT key, length(value) FROM meta LIMIT 20;"
else
  kv "meta_table" "absent"
  kv "schema_warning" "not Merkle-style store (no meta table)"
fi

if sqlite3 "file:${DB}?mode=ro" "SELECT name FROM sqlite_master WHERE type='table' AND name='blobs';" | grep -q blobs; then
  kv "blob_count" "$(sqlite3 "file:${DB}?mode=ro" "SELECT COUNT(*) FROM blobs;")"
fi
```

```bash
chmod +x ~/.cursor/skills/cursor-detective/scripts/inspect-store-db.sh
```

- [ ] **Step 2: Fixture smoke** (run in Task 12 `tests/smoke.sh`)

---

### Task 9: `grep-workbench.sh`

**Files:**
- Create: `~/.cursor/skills/cursor-detective/scripts/grep-workbench.sh`

- [ ] **Step 1: Write script**

```bash
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_lib.sh"

FILE=""
PATTERN=""
BUILTIN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --file) FILE="$2"; shift 2 ;;
    --pattern) PATTERN="$2"; shift 2 ;;
    --builtin) BUILTIN=true; shift ;;
    -h|--help) echo "Usage: grep-workbench.sh [--file PATH] [--pattern REGEX] [--builtin]"; exit 0 ;;
    *) die "unknown arg: $1" ;;
  esac
done

if [[ -z "$FILE" ]]; then
  wb="$( "${SCRIPT_DIR}/locate-cursor.sh" | awk -F= '/^WORKBENCH_JS=/{print $2}' | tail -n 1 )"
  FILE="$wb"
fi

[[ -f "$FILE" ]] || die "workbench JS not found (pass --file PATH)"

emit_header "grep-workbench.sh" "truncation_max=${TRUNCATE_MAX}"

patterns=()
if [[ "$BUILTIN" == true || -z "$PATTERN" ]]; then
  patterns=(toolFormerData composerData cursorDiskKV store.db composer.composerHeaders createComposer)
elif [[ -n "$PATTERN" ]]; then
  patterns=("$PATTERN")
fi

for pat in "${patterns[@]}"; do
  kv "pattern" "$pat"
  hits="$(grep -oE ".{0,40}${pat}.{0,40}" "$FILE" 2>/dev/null | head -n "${TRUNCATE_MAX}" || true)"
  count="$(grep -c "$pat" "$FILE" 2>/dev/null || echo 0)"
  kv "hit_count" "$count"
  if [[ "$(echo "$hits" | wc -l)" -ge "${TRUNCATE_MAX}" ]]; then
    kv "truncated" "true"
  fi
  echo "$hits" | sed 's/^/snippet=/' || true
done
```

```bash
chmod +x ~/.cursor/skills/cursor-detective/scripts/grep-workbench.sh
```

- [ ] **Step 2: Run with `--help`**

```bash
~/.cursor/skills/cursor-detective/scripts/grep-workbench.sh --help
```

Expected: usage text, exit `0`.

---

### Task 10: `compare-sqlite-meta.sh`

**Files:**
- Create: `~/.cursor/skills/cursor-detective/scripts/compare-sqlite-meta.sh`

- [ ] **Step 1: Write script**

```bash
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_lib.sh"

A="" B=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --a) A="$2"; shift 2 ;;
    --b) B="$2"; shift 2 ;;
    -h|--help) echo "Usage: compare-sqlite-meta.sh --a PATH --b PATH"; exit 0 ;;
    *) die "unknown arg: $1" ;;
  esac
done

[[ -f "$A" && -f "$B" ]] || die "both --a and --b must exist"
require_cmd sqlite3

emit_header "compare-sqlite-meta.sh"
kv "a" "$A"
kv "b" "$B"

schema_a="$(sqlite3 "file:${A}?mode=ro" ".schema")"
schema_b="$(sqlite3 "file:${B}?mode=ro" ".schema")"
if [[ "$schema_a" == "$schema_b" ]]; then
  kv "schema_diff" "identical"
else
  kv "schema_diff" "different"
  echo "--- schema_a ---"
  echo "$schema_a"
  echo "--- schema_b ---"
  echo "$schema_b"
fi

while IFS= read -r tbl; do
  [[ -z "$tbl" ]] && continue
  ca="$(sqlite3 "file:${A}?mode=ro" "SELECT COUNT(*) FROM \"${tbl}\";" 2>/dev/null || echo NA)"
  cb="$(sqlite3 "file:${B}?mode=ro" "SELECT COUNT(*) FROM \"${tbl}\";" 2>/dev/null || echo NA)"
  kv "rowcount_${tbl}" "a=${ca} b=${cb}"
done < <(sqlite3 "file:${A}?mode=ro" "SELECT name FROM sqlite_master WHERE type='table' ORDER BY 1;")
```

```bash
chmod +x ~/.cursor/skills/cursor-detective/scripts/compare-sqlite-meta.sh
```

- [ ] **Step 2: Fixture diff in `tests/smoke.sh`**

---

### Task 11: `compare-dirs.sh`

**Files:**
- Create: `~/.cursor/skills/cursor-detective/scripts/compare-dirs.sh`

- [ ] **Step 1: Write script**

```bash
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_lib.sh"

A="" B=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --a) A="$2"; shift 2 ;;
    --b) B="$2"; shift 2 ;;
    -h|--help) echo "Usage: compare-dirs.sh --a DIR --b DIR"; exit 0 ;;
    *) die "unknown arg: $1" ;;
  esac
done

[[ -d "$A" && -d "$B" ]] || die "both --a and --b must be directories"

emit_header "compare-dirs.sh"
kv "a" "$A"
kv "b" "$B"

# Shallow: depth 1 files only
comm -3 \
  <(find "$A" -maxdepth 1 -type f -printf '%f %s\n' 2>/dev/null | sort) \
  <(find "$B" -maxdepth 1 -type f -printf '%f %s\n' 2>/dev/null | sort) \
  | head -n "${TRUNCATE_MAX}" | sed 's/^/diff_line=/' || true
```

```bash
chmod +x ~/.cursor/skills/cursor-detective/scripts/compare-dirs.sh
```

---

### Task 12: `tests/smoke.sh` (fixture-based)

**Files:**
- Create: `~/.cursor/skills/cursor-detective/tests/smoke.sh`

- [ ] **Step 1: Write smoke harness**

```bash
#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPTS="${ROOT}/scripts"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Minimal state.vscdb
STATE="${TMP}/state.vscdb"
sqlite3 "$STATE" <<'SQL'
CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT);
INSERT INTO ItemTable VALUES ('composer.composerHeaders', '{"allComposers":[]}');
INSERT INTO cursorDiskKV VALUES ('composerData:00000000-0000-4000-8000-000000000001', '{}');
INSERT INTO cursorDiskKV VALUES ('bubbleId:00000000-0000-4000-8000-000000000001:b1', '{}');
SQL

"${SCRIPTS}/inspect-state-vscdb.sh" --db "$STATE" --composer-id '00000000-0000-4000-8000-000000000001' | grep -q 'bubble_keys_for_composer=1'

# store.db
STORE="${TMP}/store.db"
sqlite3 "$STORE" 'CREATE TABLE meta (key TEXT PRIMARY KEY, value BLOB); CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); INSERT INTO meta VALUES ("k","v"); INSERT INTO blobs VALUES ("1",x"00");'
"${SCRIPTS}/inspect-store-db.sh" --db "$STORE" | grep -q 'blob_count=1'

# sqlite compare
STATE_B="${TMP}/state-b.vscdb"
sqlite3 "$STATE_B" 'CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);'
"${SCRIPTS}/compare-sqlite-meta.sh" --a "$STATE" --b "$STATE_B" | grep -q 'schema_diff=different'

# dirs
mkdir -p "${TMP}/da" "${TMP}/db"
echo x > "${TMP}/da/a.txt"
"${SCRIPTS}/compare-dirs.sh" --a "${TMP}/da" --b "${TMP}/db" | grep -q '^diff_line='

"${SCRIPTS}/scan-paths.sh" >/dev/null
"${SCRIPTS}/locate-cursor.sh" >/dev/null

echo "smoke: OK"
```

```bash
chmod +x ~/.cursor/skills/cursor-detective/tests/smoke.sh
```

- [ ] **Step 2: Run smoke**

```bash
~/.cursor/skills/cursor-detective/tests/smoke.sh
```

Expected: `smoke: OK`

---

### Task 13: End-to-end skill smoke (manual)

**Files:**
- Create (by agent during smoke): `.cursor/plans/detective-cursor-storage-inventory.plan.md` in **cursor-sync** workspace (or any open repo)

- [ ] **Step 1: Invoke workflow manually**

From `/home/marcelo/dev/private/cursor-sync`:

1. Read `~/.cursor/skills/cursor-detective/SKILL.md`.
2. Theme: `cursor-storage-inventory`.
3. Run all Phase 2 scripts + `inspect-state-vscdb.sh` + `inspect-store-db.sh` on first discovered `store.db` under `~/.cursor/chats` (if any).
4. Write `.cursor/plans/detective-cursor-storage-inventory.plan.md` with all seven report sections and at least one **Confirmed** row in Scan checklist.

- [ ] **Step 2: Verify plan file**

```bash
test -f /home/marcelo/dev/private/cursor-sync/.cursor/plans/detective-cursor-storage-inventory.plan.md
grep -E '^## (Objective|Environment|Scan checklist|Findings|Diagram|Gaps|Workspace relevance)' \
  /home/marcelo/dev/private/cursor-sync/.cursor/plans/detective-cursor-storage-inventory.plan.md
```

Expected: all section headers found.

- [ ] **Step 3: Do not commit**

Per spec and AGENTS.md: no `git add` for `docs/` or skill install unless user asks.

---

## Spec coverage self-review

| Spec requirement | Task |
|------------------|------|
| Personal install `~/.cursor/skills/cursor-detective/` | Tasks 1–13 |
| `SKILL.md` pipeline + evidence + template | Task 3 |
| `reference.md` paths + examples | Task 4 |
| Seven scripts + contract | Tasks 5–11 |
| `disable-model-invocation: true` | Task 3 |
| Output `.cursor/plans/detective-<theme>.plan.md` | Task 3, 13 |
| Phase 2 script order | Task 3 |
| Phase 3 delegation table | Task 3 |
| Phase 4 theme→script map | Task 3 |
| Truncation / read-only / no sudo | Tasks 5–11 (`TRUNCATE_MAX`, `mode=ro`) |
| Smoke on Linux | Tasks 12–13 |
| No cursor-sync commit unless asked | Task 13 step 3 |

**Placeholder scan:** No TBD steps; each script body included inline.

**Type consistency:** Theme normalization matches unravel (`general-scan` fallback); script flags match spec table.

---

## Gaps (intentional v1 limits)

- `grep-workbench.sh` requires a local install or `--file`; report **Unknown** when `WORKBENCH_JS` empty.
- `inspect-state-vscdb.sh` against live DBs while Cursor is running may lock — note in **Gaps** section of reports.
- No automated install of the skill from cursor-sync CI; personal path only.
