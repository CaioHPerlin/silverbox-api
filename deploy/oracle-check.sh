#!/usr/bin/env bash
set -euo pipefail
umask 077
check=${1:?Check directory required}
component=${2:?Component required}
image=${3:?Image required}
registry_user=${4:?Registry user required}
[[ "$check" =~ ^/home/perlin/silverbox/checks/(api|web)/[a-f0-9]{40}$ ]] || exit 1
IFS= read -r token
[[ -n "$token" ]] || exit 1
tools=$(mktemp -d /tmp/silverbox-check-tools.XXXXXX)
node_container=''
cleanup() {
  if [[ -n "$node_container" ]]; then docker rm -f "$node_container" >/dev/null 2>&1 || true; fi
  rm -rf -- "$tools" "$check"
}
trap cleanup EXIT
# Extract a native Node24 binary temporarily; no system packages or Node installation.
docker pull node:24-bookworm-slim >/dev/null
node_container=$(docker create node:24-bookworm-slim)
docker cp "$node_container:/usr/local/bin/node" "$tools/node"
docker rm "$node_container" >/dev/null
node_container=''
cd "$check"
DEPLOY_COMPONENT="$component" DEPLOY_IMAGE="$image" DEPLOY_USER="$registry_user" DEPLOY_TOKEN="$token" \
  "$tools/node" --test deploy/test/release.test.ts
