#!/usr/bin/env bash
# Idempotent Cloud Agent bootstrap for Invook.
#
# Installs the local infrastructure that `make dev` normally provides through
# Docker (PostgreSQL with pgvector and a MinIO S3-compatible store), installs
# workspace dependencies, initializes a user-owned PostgreSQL cluster, and
# scaffolds a local .env.local. Runtime services are launched by start.sh.
set -euo pipefail

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_root"

state_dir="${INVOOK_STATE_DIR:-$HOME/.invook}"
pgdata="$state_dir/pgdata"
minio_data="$state_dir/minio"
mkdir -p "$state_dir/logs" "$minio_data"

pg_bindir="/usr/lib/postgresql/16/bin"

echo "==> Installing system packages (PostgreSQL 16, pgvector, tooling)"
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
  postgresql-16 postgresql-16-pgvector postgresql-client-16 ca-certificates curl

echo "==> Installing MinIO server and client"
if ! command -v minio >/dev/null 2>&1; then
  sudo curl -fsSL https://dl.min.io/server/minio/release/linux-amd64/minio -o /usr/local/bin/minio
  sudo chmod +x /usr/local/bin/minio
fi
if ! command -v mc >/dev/null 2>&1; then
  sudo curl -fsSL https://dl.min.io/client/mc/release/linux-amd64/mc -o /usr/local/bin/mc
  sudo chmod +x /usr/local/bin/mc
fi

echo "==> Installing workspace dependencies"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
corepack enable
pnpm install --frozen-lockfile

echo "==> Initializing PostgreSQL cluster"
if [ ! -s "$pgdata/PG_VERSION" ]; then
  "$pg_bindir/initdb" \
    --username=invook \
    --auth-local=trust \
    --auth-host=trust \
    --encoding=UTF8 \
    --pgdata="$pgdata" >/dev/null
  {
    echo "port = 54322"
    echo "listen_addresses = '127.0.0.1'"
    echo "unix_socket_directories = '/tmp'"
  } >>"$pgdata/postgresql.conf"
fi

echo "==> Scaffolding .env.local"
if [ ! -f .env.local ]; then
  cp .env.example .env.local
  better_auth_secret=$(openssl rand -base64 32)
  token_encryption_key=$(openssl rand -base64 32)
  # Populate local-only secrets so the stack boots. Provider credentials
  # (Google OAuth, Temporal Cloud, AI) are injected from Cursor Secrets at
  # runtime and intentionally left blank here.
  sed -i "s|^BETTER_AUTH_SECRET=.*|BETTER_AUTH_SECRET=${better_auth_secret}|" .env.local
  sed -i "s|^TOKEN_ENCRYPTION_KEY=.*|TOKEN_ENCRYPTION_KEY=${token_encryption_key}|" .env.local
fi

echo "==> Install complete"
