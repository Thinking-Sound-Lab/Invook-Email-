#!/usr/bin/env bash
# Idempotent per-boot startup for Invook local infrastructure.
#
# Starts the user-owned PostgreSQL cluster and MinIO store, ensures the
# application database and object-storage bucket exist, and applies database
# migrations. Application dev servers (API and web) run as tmux terminals.
set -euo pipefail

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_root"

state_dir="${INVOOK_STATE_DIR:-$HOME/.invook}"
pgdata="$state_dir/pgdata"
minio_data="$state_dir/minio"
log_dir="$state_dir/logs"
mkdir -p "$log_dir"

pg_bindir="/usr/lib/postgresql/16/bin"

# Load local environment (S3 credentials, database URL) if present.
if [ -f .env.local ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env.local
  set +a
fi

s3_access_key="${S3_ACCESS_KEY_ID:-invook}"
s3_secret_key="${S3_SECRET_ACCESS_KEY:-invook-local-secret}"
s3_bucket="${S3_BUCKET:-invook-mail}"

echo "==> Starting PostgreSQL"
if ! "$pg_bindir/pg_ctl" -D "$pgdata" status >/dev/null 2>&1; then
  "$pg_bindir/pg_ctl" -D "$pgdata" -l "$log_dir/postgres.log" -w start
fi

# Wait for readiness, then ensure the application database exists.
"$pg_bindir/pg_isready" -h 127.0.0.1 -p 54322 -t 30 >/dev/null
if ! psql -h 127.0.0.1 -p 54322 -U invook -tAc \
  "SELECT 1 FROM pg_database WHERE datname='invook'" | grep -q 1; then
  createdb -h 127.0.0.1 -p 54322 -U invook invook
fi

echo "==> Starting MinIO"
if ! curl -fsS http://127.0.0.1:9000/minio/health/live >/dev/null 2>&1; then
  MINIO_ROOT_USER="$s3_access_key" \
  MINIO_ROOT_PASSWORD="$s3_secret_key" \
    nohup minio server "$minio_data" --address ":9000" --console-address ":9001" \
    >"$log_dir/minio.log" 2>&1 &
fi

# Wait for MinIO to become live, then ensure the bucket exists.
for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:9000/minio/health/live >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
mc alias set invook-local http://127.0.0.1:9000 "$s3_access_key" "$s3_secret_key" >/dev/null
mc mb --ignore-existing "invook-local/$s3_bucket" >/dev/null

echo "==> Applying database migrations"
pnpm db:migrate

echo "==> Startup complete"
