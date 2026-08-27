#!/usr/bin/env sh
set -eu

fail() {
  echo "Local reset failed: $*" >&2
  exit 1
}

if [ "$#" -ne 2 ] || [ "$1" != "--confirm" ] || [ "$2" != "invook-local-data" ]; then
  echo "Usage: $0 --confirm invook-local-data" >&2
  exit 2
fi

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$project_root"

[ -f .env.local ] || fail "create .env.local from .env.example first."

set -a
. ./.env.local
set +a

export DATABASE_URL_DOCKER="postgresql://invook:invook@db:5432/invook"

compose_file="docker/compose.yml"

compose() {
  docker compose -f "$compose_file" "$@"
}

compose config --format json | pnpm exec tsx docker/reset-local-config.ts

echo "Reset scope: PostgreSQL product rows and objects in MinIO bucket invook-mail."
echo "Preserved: Temporal Cloud histories, schemas, Drizzle migrations, the MinIO bucket, Docker volumes, .env.local, credentials, and source files."

if ! compose stop web api worker; then
  echo "Compose reported a stop error; verifying that all application services stopped." >&2
fi

for service_name in web api worker; do
  container_id=$(compose ps -a -q "$service_name")
  if [ -n "$container_id" ] && [ "$(docker inspect "$container_id" --format '{{.State.Running}}')" != "false" ]; then
    fail "application service $service_name is still running."
  fi
done

echo "Application services stopped."
compose up -d --wait db minio

for service_name in db minio; do
  container_id=$(compose ps -q "$service_name")
  [ -n "$container_id" ] || fail "local $service_name container is not running."
  project_label=$(docker inspect "$container_id" --format '{{index .Config.Labels "com.docker.compose.project"}}')
  service_label=$(docker inspect "$container_id" --format '{{index .Config.Labels "com.docker.compose.service"}}')
  [ "$project_label" = "invook" ] || fail "$service_name container is not in the invook project."
  [ "$service_label" = "$service_name" ] || fail "$service_name container label does not match."
done

psql_command='psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'

migration_count_before=$(compose exec -T db sh -c "$psql_command -Atc 'SELECT count(*) FROM drizzle.__drizzle_migrations'")
case "$migration_count_before" in
  ''|*[!0-9]*) fail "could not read the Drizzle migration history." ;;
esac
[ "$migration_count_before" -gt 0 ] || fail "the Drizzle migration history is empty."

unexpected_schema_tables=$(compose exec -T db sh -c "$psql_command -Atc \"SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('public', 'drizzle', 'information_schema') AND schemaname NOT LIKE 'pg_%'\"")
[ "$unexpected_schema_tables" -eq 0 ] || fail "application tables exist outside the known public schema."

missing_required_tables=$(compose exec -T db sh -c "$psql_command -At" <<'SQL'
SELECT count(*)
FROM (
  VALUES
    ('profiles'),
    ('connected_accounts'),
    ('messages'),
    ('drafts'),
    ('memory_entries'),
    ('workflow_steps'),
    ('temporal_commands')
) AS required(table_name)
WHERE to_regclass('public.' || quote_ident(required.table_name)) IS NULL;
SQL
)
[ "$missing_required_tables" -eq 0 ] || fail "the PostgreSQL schema does not match the known Invook product schema."

compose exec -T db sh -c "$psql_command" <<'SQL'
BEGIN;
SELECT format('TRUNCATE TABLE %I.%I RESTART IDENTITY CASCADE;', schemaname, tablename)
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename <> '__drizzle_migrations'
ORDER BY tablename
\gexec
COMMIT;
SQL

compose run --rm --no-deps --entrypoint /bin/sh minio-init -c '
  set -eu
  [ "$S3_BUCKET" = "invook-mail" ]
  mc alias set invook http://minio:9000 "$S3_ACCESS_KEY_ID" "$S3_SECRET_ACCESS_KEY" >/dev/null
  version_state=$(mc version info "invook/$S3_BUCKET")
  case "$version_state" in
    *" is un-versioned") ;;
    *) echo "Local reset failed: MinIO bucket must be the known unversioned local bucket." >&2; exit 1 ;;
  esac
  mc rm --recursive --force --dangerous "invook/$S3_BUCKET" >/dev/null
  mc stat "invook/$S3_BUCKET" >/dev/null
  listing_file=/tmp/invook-reset-object-listing
  mc ls --recursive --json "invook/$S3_BUCKET" >"$listing_file"
  [ ! -s "$listing_file" ] || {
    echo "Local reset failed: MinIO bucket still contains objects." >&2
    exit 1
  }
'

compose exec -T db sh -c "$psql_command" <<'SQL'
DO $$
DECLARE
  application_table record;
  row_count bigint;
BEGIN
  FOR application_table IN
    SELECT schemaname, tablename
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename <> '__drizzle_migrations'
  LOOP
    EXECUTE format(
      'SELECT count(*) FROM %I.%I',
      application_table.schemaname,
      application_table.tablename
    ) INTO row_count;
    IF row_count <> 0 THEN
      RAISE EXCEPTION 'Product table %.% is not empty',
        application_table.schemaname,
        application_table.tablename;
    END IF;
  END LOOP;
END
$$;
SQL

migration_count_after=$(compose exec -T db sh -c "$psql_command -Atc 'SELECT count(*) FROM drizzle.__drizzle_migrations'")
[ "$migration_count_after" = "$migration_count_before" ] || fail "Drizzle migration history changed during reset."

database_evidence=$(compose exec -T db sh -c "$psql_command -At" <<'SQL'
SELECT 'profiles=' || count(*) FROM profiles
UNION ALL SELECT 'connected_accounts=' || count(*) FROM connected_accounts
UNION ALL SELECT 'messages=' || count(*) FROM messages
UNION ALL SELECT 'drafts=' || count(*) FROM drafts
UNION ALL SELECT 'memory_entries=' || count(*) FROM memory_entries
UNION ALL SELECT 'workflow_steps=' || count(*) FROM workflow_steps
UNION ALL SELECT 'temporal_commands=' || count(*) FROM temporal_commands;
SQL
)

compose run --rm --no-deps --entrypoint /bin/sh minio-init -c '
  set -eu
  mc alias set invook http://minio:9000 "$S3_ACCESS_KEY_ID" "$S3_SECRET_ACCESS_KEY" >/dev/null
  mc stat "invook/$S3_BUCKET" >/dev/null
  listing_file=/tmp/invook-reset-object-listing
  mc ls --recursive --json "invook/$S3_BUCKET" >"$listing_file"
  [ ! -s "$listing_file" ]
'

echo "Reset evidence:"
echo "$database_evidence"
echo "all_public_product_rows=0"
echo "drizzle_migrations_preserved=$migration_count_after"
echo "temporal_cloud_histories=preserved"
echo "mailbox_objects=0"
echo "Data stores cleared and verified; restarting the normal local stack."
compose up -d --build --wait
echo "Local reset complete. Open http://localhost:3000 to start a new Google signup."
