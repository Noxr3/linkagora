#!/usr/bin/env bash
# Replay every migration on a throwaway database and run supabase/tests/*.sql.
# Needs psql and a local Postgres; never point this at a real project.
#   PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres scripts/test-sql.sh
set -euo pipefail
cd "$(dirname "$0")/.."

case "${PGHOST:-}" in
  ""|localhost|127.0.0.1|::1) ;;
  *) echo "Refusing to run against $PGHOST: local databases only." >&2; exit 2 ;;
esac

DB="linkagora_sql_test_$$"
createdb "$DB"
trap 'dropdb --if-exists "$DB"' EXIT
run() { psql -d "$DB" -v ON_ERROR_STOP=1 -q "$@"; }

run -f supabase/tests/supabase_stub.sql 2>/dev/null
for file in $(ls supabase/migrations/*.sql | sort); do
  run -f "$file" >/dev/null 2>&1 || { echo "Migration failed: $file" >&2; run -f "$file" >&2; exit 1; }
done
for file in supabase/tests/[0-9]*.sql; do
  run -f "$file"
done
