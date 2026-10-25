#!/usr/bin/env bash
set -euo pipefail
umask 077
release=$(cd -- "$(dirname -- "$0")" && pwd)
root=$(dirname "$(dirname "$release")")
image=${1:?Immutable image required}
registry_user=${2:?Registry user required}
[[ "$image" =~ ^ghcr\.io/caiohperlin/silverbox-(api|web):[a-f0-9]{40}$ ]] || { echo 'Invalid image reference' >&2; exit 1; }
[[ -f "$root/.env" && ! -L "$root/.env" ]] || { echo 'Provision the private .env first' >&2; exit 1; }
[[ $(stat -c %a "$root/.env") == 600 && $(stat -c %u "$root/.env") == "$UID" ]] || { echo '.env must be owned by deploy user with mode 600' >&2; exit 1; }
exec 9>"$root/deploy.lock"
flock -w 300 9
export DOCKER_CONFIG
DOCKER_CONFIG=$(mktemp -d)
trap 'rm -rf -- "$DOCKER_CONFIG"' EXIT
# The ephemeral Actions token arrives through stdin, never in argv or .env.
docker login ghcr.io --username "$registry_user" --password-stdin >/dev/null
ln -sfn "$root/.env" "$release/.env"
printf '%s\n' "$image" > "$release/image"
export IMAGE="$image"
cd "$release"
docker compose -f compose.yml config --quiet
docker compose -f compose.yml pull --quiet
previous=$(readlink -f "$root/current" || true)
if ! docker compose -f compose.yml up -d --wait --wait-timeout 180 --remove-orphans; then
  echo 'New release failed health checks' >&2
  if [[ -n "$previous" && -f "$previous/image" ]]; then
    IMAGE=$(cat "$previous/image") docker compose --project-directory "$previous" -f "$previous/compose.yml" up -d --wait --wait-timeout 180 --remove-orphans
    echo 'Previous application image restored; migrations are not reversed' >&2
  fi
  exit 1
fi
ln -sfn "$release" "$root/current.next"
mv -Tf "$root/current.next" "$root/current"
docker compose -f compose.yml ps
