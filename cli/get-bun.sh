#!/bin/sh
# Puts one exact Bun release in a folder, and changes nothing else: no shell
# profile edits, no completions, nothing global. OpenMods keeps its Bun
# versions under ~/.openmods/toolchains with this, for the CLI and for the
# version each harness release pins. It downloads Bun's own npm package for
# this machine, a plain tarball, so only curl and tar are needed.
#
#   sh get-bun.sh <version> <dir>     # installs <dir>/bin/bun
set -e

VERSION="$1"
DIR="$2"
[ -n "$VERSION" ] && [ -n "$DIR" ] || { echo "usage: get-bun.sh <version> <dir>" >&2; exit 2; }

# The build for this machine, named as Bun names its packages: the OS and
# CPU, then -musl on musl-based Linux (Alpine), then -baseline on x86-64
# CPUs without AVX2.
case "$(uname -s) $(uname -m)" in
  "Darwin arm64") T=darwin-aarch64 ;;
  "Darwin x86_64")
    if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = 1 ]; then
      T=darwin-aarch64 # a shell running under Rosetta on Apple silicon
    else
      T=darwin-x64
      sysctl -n machdep.cpu.leaf7_features 2>/dev/null | grep -q AVX2 || T=darwin-x64-baseline
    fi ;;
  "Linux aarch64" | "Linux arm64") T=linux-aarch64 ;;
  "Linux x86_64") T=linux-x64 ;;
  *) echo "Bun has no build for $(uname -s) $(uname -m)." >&2; exit 1 ;;
esac
case "$T" in
  linux-*)
    if [ -f /etc/alpine-release ] || ldd --version 2>&1 | grep -qi musl; then T="$T-musl"; fi
    if [ "${T#linux-x64}" != "$T" ] && ! grep -q avx2 /proc/cpuinfo 2>/dev/null; then T="$T-baseline"; fi ;;
esac

URL="https://registry.npmjs.org/@oven/bun-$T/-/bun-$T-$VERSION.tgz"
TMP="$DIR.download.$$"
rm -rf "$TMP"
mkdir -p "$TMP"
trap 'rm -rf "$TMP"' EXIT
curl -fsSL "$URL" -o "$TMP/bun.tgz" || { echo "Could not download Bun $VERSION from $URL" >&2; exit 1; }
tar -xzf "$TMP/bun.tgz" -C "$TMP"
"$TMP/package/bin/bun" --version >/dev/null 2>&1 || { echo "Bun $VERSION ($T) does not run on this machine." >&2; exit 1; }
mkdir -p "$DIR/bin"
mv -f "$TMP/package/bin/bun" "$DIR/bin/bun"
chmod 755 "$DIR/bin/bun"
