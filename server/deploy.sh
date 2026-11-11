#!/usr/bin/env bash
# Idempotent deploy of the Dayflow Sync Server to megaserv (run from a workstation with Git Bash / any POSIX shell).
#
#   server/deploy.sh            upload source, create .env once, build the image on the host, (re)start, health-check
#   server/deploy.sh test       upload source and run `npm test` in a throwaway container against a throwaway Postgres
#   server/deploy.sh backup     pg_dump into /srv/dayflow/backups
#   server/deploy.sh status     compose ps + health
#   server/deploy.sh logs       last 200 server log lines
#
# Touches only: compose projects `dayflow` (and `dayflow-e2e` for `test`), /srv/dayflow, host port 8790.
set -euo pipefail

HOST=${DEPLOY_HOST:-192.168.0.90}
SSH_PORT=${DEPLOY_SSH_PORT:-60022}
SSH_USER=${DEPLOY_USER:-jkl}
DIR=${DEPLOY_DIR:-/srv/dayflow}
PROJECT=${DEPLOY_PROJECT:-dayflow}
APP_PORT=${DAYFLOW_PORT:-8790}
PUBLIC_URL_DEFAULT=${DAYFLOW_PUBLIC_URL:-http://$HOST:$APP_PORT}
BOOTSTRAP_DEFAULT=${DAYFLOW_BOOTSTRAP_ADMIN_EMAILS:-claude@velesagro.pl}
MODE=${1:-deploy}

ROOT=$(cd "$(dirname "$0")/.." && pwd)
SSH=(ssh -o BatchMode=yes -p "$SSH_PORT" "$SSH_USER@$HOST")

upload() {
  echo "==> uploading source to $HOST:$DIR/src"
  tar -C "$ROOT" \
    --exclude=node_modules --exclude=dist --exclude=.env --exclude=server/web/screenshots \
    -czf - server windows/src/shared/sync-types.ts windows/src/shared/detailed.ts |
    "${SSH[@]}" "set -e
      sudo mkdir -p '$DIR' && sudo chown '$SSH_USER:$SSH_USER' '$DIR' && chmod 750 '$DIR'
      rm -rf '$DIR/src.new' && mkdir -p '$DIR/src.new' && tar -xzf - -C '$DIR/src.new'
      rm -rf '$DIR/src.old'; if [ -d '$DIR/src' ]; then mv '$DIR/src' '$DIR/src.old'; fi
      mv '$DIR/src.new' '$DIR/src' && rm -rf '$DIR/src.old'"
}

remote() { "${SSH[@]}" "bash -s -- '$DIR' '$PROJECT' '$APP_PORT' '$PUBLIC_URL_DEFAULT' '$BOOTSTRAP_DEFAULT'"; }

case "$MODE" in
deploy)
  upload
  remote <<'REMOTE'
set -euo pipefail
DIR=$1 PROJECT=$2 APP_PORT=$3 PUBLIC_URL=$4 BOOTSTRAP=$5
ENV=$DIR/.env
if [ ! -f "$ENV" ]; then
  echo "==> creating $ENV with generated secrets"
  umask 077
  PGPW=$(openssl rand -hex 24)
  {
    echo "# Dayflow Sync Server configuration (generated $(date -Is)). Keep mode 600."
    echo "POSTGRES_PASSWORD=$PGPW"
    echo "DATABASE_URL=postgres://dayflow:$PGPW@dayflow-postgres:5432/dayflow"
    echo "JWT_SECRET=$(openssl rand -hex 48)"
    echo "PUBLIC_URL=$PUBLIC_URL"
    echo "# Google OAuth client of type 'Desktop app' (see README.md), then: server/deploy.sh"
    echo "GOOGLE_CLIENT_ID="
    echo "GOOGLE_CLIENT_SECRET="
    echo "# Google OAuth client of type 'Web application'; authorize the PUBLIC_URL origin"
    echo "GOOGLE_WEB_CLIENT_ID="
    echo "# optional, comma-separated, e.g. velesagro.pl"
    echo "ALLOWED_EMAIL_DOMAINS="
    echo "BOOTSTRAP_ADMIN_EMAILS=$BOOTSTRAP"
    echo "DEV_AUTH=0"
    echo "# optional Odoo defaults (workspace admins normally configure Odoo in the dashboard)"
    echo "ODOO_URL="
    echo "ODOO_DB="
    echo "ODOO_LOGIN="
    echo "ODOO_API_KEY="
    echo "LOG_LEVEL=info"
    echo "# compose wiring"
    echo "DAYFLOW_ENV_FILE=$ENV"
    echo "DAYFLOW_BIND=0.0.0.0"
    echo "DAYFLOW_PORT=$APP_PORT"
  } > "$ENV"
fi
chmod 600 "$ENV"
if grep -Eq '^DEV_AUTH=(1|true)' "$ENV"; then echo "refusing to deploy: DEV_AUTH is enabled in $ENV" >&2; exit 1; fi

cd "$DIR/src/server"
DC=(sudo docker compose -p "$PROJECT" --env-file "$ENV" -f docker-compose.yml)
if ss -ltn | grep -q ":$APP_PORT " && [ -z "$("${DC[@]}" ps -q dayflow-server 2>/dev/null)" ]; then
  echo "port $APP_PORT is in use by something else; aborting" >&2; exit 1
fi
echo "==> building image on the host"
"${DC[@]}" build dayflow-server
echo "==> starting"
"${DC[@]}" up -d --remove-orphans
for i in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$APP_PORT/api/health" >/dev/null 2>&1; then
    curl -fsS "http://127.0.0.1:$APP_PORT/api/health"; echo
    "${DC[@]}" ps
    exit 0
  fi
  sleep 2
done
echo "server did not become healthy" >&2
"${DC[@]}" logs --tail 100 dayflow-server >&2
exit 1
REMOTE
  ;;
test)
  upload
  remote <<'REMOTE'
set -uo pipefail
DIR=$1
cd "$DIR/src/server"
DC=(sudo docker compose -p dayflow-e2e -f docker-compose.test.yml)
"${DC[@]}" up --build --attach tests --abort-on-container-exit --exit-code-from tests </dev/null
rc=$?
"${DC[@]}" down -v --rmi local >/dev/null 2>&1
exit $rc
REMOTE
  ;;
e2e)
  # Temporary stack: project dayflow-e2e, DEV_AUTH=1, 127.0.0.1:${E2E_PORT:-18790}, own volume; removed afterwards.
  upload
  E2E_PORT=${E2E_PORT:-18790}
  "${SSH[@]}" "bash -s -- '$DIR' '$E2E_PORT'" <<'REMOTE'
set -uo pipefail
DIR=$1 PORT=$2
if ss -ltn | grep -q ":$PORT "; then echo "port $PORT busy" >&2; exit 1; fi
E=$DIR/e2e; mkdir -p "$E"; chmod 700 "$E"
PGPW=$(openssl rand -hex 16)
umask 077
cat > "$E/e2e.env" <<EOF
POSTGRES_PASSWORD=$PGPW
DATABASE_URL=postgres://dayflow:$PGPW@dayflow-postgres:5432/dayflow
JWT_SECRET=$(openssl rand -hex 32)
PUBLIC_URL=http://127.0.0.1:$PORT
DEV_AUTH=1
BOOTSTRAP_ADMIN_EMAILS=owner@example.com
DAYFLOW_ENV_FILE=$E/e2e.env
DAYFLOW_BIND=127.0.0.1
DAYFLOW_PORT=$PORT
DAYFLOW_IMAGE=dayflow-server:e2e
EOF
cd "$DIR/src/server"
DC=(sudo docker compose -p dayflow-e2e --env-file "$E/e2e.env" -f docker-compose.yml -f docker-compose.e2e.yml)
rc=1
if "${DC[@]}" up -d --build dayflow-postgres dayflow-server; then
  for i in $(seq 1 60); do curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break; sleep 2; done
  echo "host health: $(curl -fsS "http://127.0.0.1:$PORT/api/health")"
  "${DC[@]}" run --rm -T --build --use-aliases e2e-runner </dev/null; rc=$?
  [ $rc -ne 0 ] && "${DC[@]}" logs --tail 80 dayflow-server
fi
"${DC[@]}" down -v --rmi local --remove-orphans >/dev/null 2>&1
sudo docker image rm dayflow-server:e2e >/dev/null 2>&1
rm -rf "$E"
echo "e2e stack removed (rc=$rc)"
exit $rc
REMOTE
  ;;
backup)
  remote <<'REMOTE'
set -euo pipefail
DIR=$1 PROJECT=$2
mkdir -p "$DIR/backups" && chmod 700 "$DIR/backups"
OUT="$DIR/backups/dayflow-$(date +%Y%m%d-%H%M%S).dump"
sudo docker compose -p "$PROJECT" --env-file "$DIR/.env" -f "$DIR/src/server/docker-compose.yml" \
  exec -T dayflow-postgres pg_dump -U dayflow -d dayflow -Fc > "$OUT" </dev/null # exec reads stdin: keep the rest of this script
chmod 600 "$OUT"
ls -l "$OUT"
REMOTE
  ;;
status)
  remote <<'REMOTE'
DIR=$1 PROJECT=$2 APP_PORT=$3
sudo docker compose -p "$PROJECT" --env-file "$DIR/.env" -f "$DIR/src/server/docker-compose.yml" ps
curl -fsS "http://127.0.0.1:$APP_PORT/api/health"; echo
REMOTE
  ;;
logs)
  remote <<'REMOTE'
DIR=$1 PROJECT=$2
sudo docker compose -p "$PROJECT" --env-file "$DIR/.env" -f "$DIR/src/server/docker-compose.yml" logs --tail 200 dayflow-server
REMOTE
  ;;
*)
  echo "usage: $0 [deploy|test|backup|status|logs]" >&2
  exit 2
  ;;
esac
