#!/bin/sh
# Installs the openmods CLI: a clone of the registry (the mods list) under
# ~/.openmods, the program itself in ~/.openmods/cli, and an `openmods`
# command in ~/.openmods/bin, which install also puts first on your PATH.
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

if [ ! -x "$BUN" ]; then
  echo "Getting Bun $BUN_VERSION for the CLI, into $OM/toolchains"
  sh "$OM/registry/cli/get-bun.sh" "$BUN_VERSION" "$OM/toolchains/bun-$BUN_VERSION"
fi

# The program runs from its own copy, so pulling the mods list never changes
# it; `openmods update` replaces the copy and says so.
VERSION=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$OM/registry/cli/package.json" | head -n 1)
COMMIT=$(git -C "$OM/registry" rev-parse --short HEAD)
rm -rf "$OM/cli.new"
mkdir -p "$OM/cli.new"
cp -R "$OM/registry/cli/src" "$OM/registry/cli/get-bun.sh" "$OM/registry/cli/package.json" "$OM/cli.new/"
printf '%s (%s)\n' "$VERSION" "$COMMIT" > "$OM/cli.new/.version"
rm -rf "$OM/cli"
mv "$OM/cli.new" "$OM/cli"

# Bun caches the CLI's transpiled code; on Linux it would go in ~/.bun.
cat > "$OM/bin/openmods" <<WRAP
#!/bin/sh
OM="\${OPENMODS_HOME:-\$HOME/.openmods}"
export BUN_RUNTIME_TRANSPILER_CACHE_PATH="\${BUN_RUNTIME_TRANSPILER_CACHE_PATH-\$OM/cache/transpiler}"
exec "\$OM/toolchains/bun-$BUN_VERSION/bin/bun" "\$OM/cli/src/index.ts" "\$@"
WRAP
chmod 755 "$OM/bin/openmods"

# PATH, and a launcher in front of each harness you have (see `openmods help setup`).
"$OM/bin/openmods" setup

echo "openmods is installed. Try: openmods list"
