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
    # find does not follow symbolic links or cross into other mounts, and
    # chown -h changes a link itself. A file with several hard links may also
    # exist outside the directory, so it is left for the operator to check.
    count=$(find "$real" -xdev -user 0 \( -type d -o -links 1 \) | wc -l)
    if [ "$count" -gt 0 ]; then
      echo "Giving $count root-owned entries under $real to $APP_USER..."
      find "$real" -xdev -user 0 \( -type d -o -links 1 \) -exec chown -h "$APP_USER:$APP_USER" {} +
    fi
    linked=$(find "$real" -xdev -user 0 ! -type d -links +1 | wc -l)
    if [ "$linked" -gt 0 ]; then
      echo "Not changing $linked root-owned files with several hard links under $real; check and chown them yourself." >&2
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
uid=$(id -u)
for dir in "$STORAGE_PATH" "$DEX_PATH"; do
  if [ ! -w "$dir" ] || [ -n "$(find "$dir" -user 0 -print -quit 2>/dev/null)" ]; then
    echo "$dir is not writable by uid $uid, or holds files owned by root (for example" >&2
    echo "from an older image, which ran as root, or a volume root created by root)." >&2
    real=$(cd "$dir" 2>/dev/null && pwd -P || printf '%s' "$dir")
    # fix-permissions only helps werkyn, and only under the data roots.
    case "$uid:$real" in
      10001:/app/storage | 10001:/app/storage/* | 10001:/app/data | 10001:/app/data/*)
        cat >&2 <<EOF
The bundled docker-compose.yml hands them to the werkyn user before every
start. Otherwise do it once with

  docker run --rm --user 0 -v <volume>:$dir <image> fix-permissions
EOF
        ;;
      *)
        cat >&2 <<EOF
fix-permissions gives only /app/storage and /app/data to werkyn (uid 10001), so
give this directory and everything in it to uid $uid yourself, for example
chown -Rh $uid:$(id -g) on the host directory or volume.
EOF
        ;;
    esac
    echo "See docs/remediation/ops-004.md." >&2
    exit 1
  fi
done

echo "Running database migrations..."
cd /app/packages/backend
prisma migrate deploy

echo "Starting server..."
cd /app
exec node /app/packages/backend/dist/server.js
