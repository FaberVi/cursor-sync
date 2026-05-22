#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SQL="${ROOT}/resources/golden-store-template.sql"
DB="${ROOT}/resources/golden-chat-store.template.db"
python3 - "${SQL}" "${DB}" <<'PY'
import sqlite3
import sys
from pathlib import Path

sql_path, db_path = Path(sys.argv[1]), Path(sys.argv[2])
db_path.unlink(missing_ok=True)
conn = sqlite3.connect(db_path)
conn.executescript(sql_path.read_text(encoding="utf-8"))
conn.close()
print(f"built {db_path} ({db_path.stat().st_size} bytes)")
PY
