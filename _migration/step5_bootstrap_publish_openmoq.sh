#!/usr/bin/env bash
set -euo pipefail

# Step 5: Bootstrap publish @openmoq/* packages from local tarballs.
# Run from repo root with npm auth as an owner/publisher in @openmoq.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "==> Validating workspace before bootstrap publish"
pnpm install
pnpm -r build
pnpm test
pnpm smoke:exports

echo "==> Packing publishable packages"
mkdir -p release
rm -f release/*.tgz || true
pnpm --filter "./packages/*" pack --pack-destination "$PWD/release"

echo "==> Verifying tarball package names"
expected=(
  "@openmoq/browser"
  "@openmoq/loc"
  "@openmoq/locmaf"
  "@openmoq/msf"
  "@openmoq/playback"
  "@openmoq/player"
  "@openmoq/quic"
  "@openmoq/transport"
  "@openmoq/webtransport"
  "@openmoq/playa"
)

declare -A seen=()
for tgz in release/*.tgz; do
  name="$(tar -xOzf "$tgz" package/package.json | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).name")"
  seen["$name"]=1
done

for name in "${expected[@]}"; do
  if [[ -z "${seen[$name]:-}" ]]; then
    echo "Missing tarball for ${name}" >&2
    exit 1
  fi
done

echo "==> Publishing tarballs (one-time bootstrap)"
for tgz in release/*.tgz; do
  name="$(tar -xOzf "$tgz" package/package.json | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).name")"
  version="$(tar -xOzf "$tgz" package/package.json | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).version")"
  if [[ "$name" != @openmoq/* ]]; then
    echo "Skipping non-openmoq package in tarball: ${name}@${version}"
    continue
  fi
  echo "Publishing ${name}@${version} from ${tgz}"
  npm publish "file:${tgz}" --access public
done

echo "Bootstrap publish complete."
