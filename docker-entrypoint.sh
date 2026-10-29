#!/bin/sh
# Runs the database migrations and the server (which starts Dex) as the
# unprivileged user werkyn (uid and gid 10001), the image's default user.
#
# Images before this one ran as root, so an existing installation's storage and
# Dex directories hold files owned by root that werkyn cannot change. Started as
# root, this script gives every file owned by root in those two directories to
# werkyn, if they lie under /app/storage or /app/data, and then continues as
# werkyn; nothing else runs as root. Files owned by other users are left alone.
#
#   docker-entrypoint.sh                  migrate, then start the server
#   docker-entrypoint.sh fix-permissions  as root: only hand over the files
set -eu

APP_USER=werkyn

# Relative paths resolve against /app, the server's working directory.
data_dir() {
  case "$1" in
    /*) printf '%s\n' "$1" ;;
    *) printf '/app/%s\n' "${1#./}" ;;
  esac
}
STORAGE_PATH=$(data_dir "${STORAGE_DIR:-./storage}")
DEX_PATH=$(data_dir "${DEX_CONFIG_DIR:-/app/data/dex}")

fix_permissions() {
  for dir in "$STORAGE_PATH" "$DEX_PATH"; do
    [ -d "$dir" ] || continue
    # Only the image's data roots, where the volumes are mounted, are handed
    # over. The check uses the resolved path, so a symbolic link cannot point it
    # elsewhere; a directory configured outside them is left to the operator.
    real=$(cd "$dir" && pwd -P)
    case "$real" in
      /app/storage | /app/storage/* | /app/data | /app/data/*) ;;
      *)
        echo "Not changing owners under $real: only /app/storage and /app/data are handed over." >&2
        echo "Make it writable by uid 10001 yourself; see docs/remediation/ops-004.md." >&2
        continue
        ;;
    esac
    # find does not follow symbolic links and chown -h changes a link itself,
    # so nothing outside the directory is touched.
    count=$(find "$real" -user 0 | wc -l)
    if [ "$count" -gt 0 ]; then
      echo "Giving $count root-owned entries under $real to $APP_USER..."
      find "$real" -user 0 -exec chown -h "$APP_USER:$APP_USER" {} +
    fi
  done
}

if [ "$(id -u)" = 0 ]; then
  fix_permissions
  if [ "${1:-}" = fix-permissions ]; then
    exit 0
  fi
  exec su-exec "$APP_USER" "$0" "$@"
fi

if [ "${1:-}" = fix-permissions ]; then
  echo "fix-permissions must run as root (docker run --user 0 ... or Compose user: \"0\")." >&2
  exit 1
fi

echo "Preparing data directories..."
mkdir -p "$STORAGE_PATH" "$DEX_PATH" 2>/dev/null || true
for dir in "$STORAGE_PATH" "$DEX_PATH"; do
  if [ ! -w "$dir" ] || [ -n "$(find "$dir" -user 0 -print -quit 2>/dev/null)" ]; then
    cat >&2 <<EOF
$dir is not writable by uid $(id -u), or holds files owned by root that an
older image (which ran as root) created. The bundled docker-compose.yml hands
them to the werkyn user before every start. Otherwise do it once with

  docker run --rm --user 0 -v <volume>:$dir <image> fix-permissions

or start this container once with --user 0: it hands the files over and then
runs as werkyn. See docs/remediation/ops-004.md.
EOF
    exit 1
  fi
done

echo "Running database migrations..."
cd /app/packages/backend
prisma migrate deploy

echo "Starting server..."
cd /app
exec node /app/packages/backend/dist/server.js
