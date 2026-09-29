#!/bin/sh
# Installs the openmods CLI: a clone of the registry (the mods list) under
# ~/.openmods, the newest release of the program itself in ~/.openmods/cli,
# and an `openmods` command in ~/.openmods/bin, which install also puts first
# on your PATH.
# The CLI runs on its own copy of Bun, kept in ~/.openmods/toolchains with
# the versions harness builds pin; nothing outside ~/.openmods changes
# except the PATH line in your shell's startup files. Needs git, curl and tar.
#
#   curl -fsSL https://openmods.dev/install.sh | sh
set -e

OM="${OPENMODS_HOME:-$HOME/.openmods}"
REG="${OPENMODS_REGISTRY:-https://github.com/shouryamaanjain/openmods}"
BUN_VERSION=1.3.14
BUN="$OM/toolchains/bun-$BUN_VERSION/bin/bun"

for c in git curl tar; do
  command -v "$c" >/dev/null 2>&1 || { echo "openmods needs $c. Install it and run this again."; exit 1; }
done

mkdir -p "$OM/bin"
if [ -d "$OM/registry/.git" ]; then
  git -C "$OM/registry" pull -q --ff-only || true
else
  case "$REG" in
    http*|git@*|ssh://*) git clone -q --depth 1 "$REG" "$OM/registry" ;;
    *) git clone -q "$REG" "$OM/registry" ;;
  esac
fi

# The newest release (a vX.Y.Z tag): code merged since then never runs here.
TAG=$(git -C "$OM/registry" ls-remote --tags --refs origin 'v*' | sed -n 's#.*refs/tags/\(v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)$#\1#p' |
  awk -F. '{ sub(/^v/, "", $1); printf "%09d%09d%09d v%s.%s.%s\n", $1, $2, $3, $1, $2, $3 }' | sort | tail -n 1 | cut -d' ' -f2)
[ -n "$TAG" ] || { echo "openmods: found no release of OpenMods at $REG; is it reachable?"; exit 1; }
git -C "$OM/registry" fetch -q --depth 1 origin tag "$TAG"
NEW="$OM/.install-$$"
rm -rf "$NEW" && mkdir -p "$NEW"
trap 'rm -rf "$NEW"' EXIT
git -C "$OM/registry" archive --format=tar "$TAG" cli/src cli/package.json cli/get-bun.sh | tar -x -C "$NEW"

if [ ! -x "$BUN" ]; then
  echo "Getting Bun $BUN_VERSION for the CLI, into $OM/toolchains"
  sh "$NEW/cli/get-bun.sh" "$BUN_VERSION" "$OM/toolchains/bun-$BUN_VERSION"
fi

# Bun caches the CLI's transpiled code; on Linux it would go in ~/.bun.
cat > "$OM/bin/openmods" <<WRAP
#!/bin/sh
OM="\${OPENMODS_HOME:-\$HOME/.openmods}"
export BUN_RUNTIME_TRANSPILER_CACHE_PATH="\${BUN_RUNTIME_TRANSPILER_CACHE_PATH-\$OM/cache/transpiler}"
exec "\$OM/toolchains/bun-$BUN_VERSION/bin/bun" "\$OM/cli/src/index.ts" "\$@"
WRAP
chmod 755 "$OM/bin/openmods"

# The program in ~/.openmods/cli, where it runs from then on, so pulling the
# mods list never changes it; PATH; and a launcher in front of each harness
# you have, which starts your stock one until you install a mod for it
# (`setup`, run only from here, from the release just fetched).
BUN_RUNTIME_TRANSPILER_CACHE_PATH="${BUN_RUNTIME_TRANSPILER_CACHE_PATH-$OM/cache/transpiler}" "$BUN" "$NEW/cli/src/index.ts" setup || true
if [ "$(cat "$OM/cli/.version" 2>/dev/null)" != "${TAG#v}" ] || ! grep -q '"\$OM/cli/src/index.ts"' "$OM/bin/openmods"; then
  echo "openmods could not set itself up in $OM/cli; the message above says why."
  exit 1
fi

echo "openmods is installed. Try: openmods list"
