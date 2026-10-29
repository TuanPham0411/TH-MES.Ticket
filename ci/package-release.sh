#!/bin/bash
set -euo pipefail
project=th-ticket
root=$(pwd)
release="$root/work/release"
mkdir -p "$root/work/node"
rm -rf "$release"
mkdir -p "$release/runtime"
cp -a dist "$release/dist"
for name in start.mjs package.json package-lock.json; do
  if test -f "$name"; then cp "$name" "$release/"; fi
done
if test -d ticket/dist; then mkdir -p "$release/ticket"; cp -a ticket/dist "$release/ticket/dist"; fi
if test -d deploy; then cp -a deploy "$release/deploy"; fi
if test -f RELEASE-README.md; then cp RELEASE-README.md "$release/"; fi

cd "$root/work/node"
if test -n "${NODE_ARM64_ARCHIVE:-}"; then
  archive="$NODE_ARM64_ARCHIVE"
else
  curl --fail --location --retry 3 --max-time 120 https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt -o SHASUMS256.txt
  archive=$(awk '$2 ~ /^node-v22\..*-linux-arm64.tar.xz$/ {print $2}' SHASUMS256.txt)
  test -n "$archive"
  curl --fail --location --retry 3 --max-time 180 "https://nodejs.org/dist/latest-v22.x/$archive" -o "$archive"
  awk -v f="$archive" '$2==f' SHASUMS256.txt | sha256sum -c -
fi
tar -xJf "$archive" --strip-components=1 -C "$release/runtime"
cd "$root/work"
revision=$(git -C "$root" rev-parse --short=12 HEAD)
tar -C release -czf "$project-$revision-pi-arm64.tar.gz" .
sha256sum "$project-$revision-pi-arm64.tar.gz" > "$project-$revision-pi-arm64.tar.gz.sha256"
git -C "$root" archive --format=tar.gz --output="$root/work/$project-$revision-source.tar.gz" HEAD
sha256sum "$project-$revision-source.tar.gz" > "$project-$revision-source.tar.gz.sha256"
echo "Prepared ARM64 release and source archives; no production deployment performed."
