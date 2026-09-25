#!/bin/sh
# Installs the openmods CLI: a clone of the registry under ~/.openmods and
# an `openmods` command in ~/.openmods/bin, which install also puts first
# on your PATH. The CLI runs on its own copy of Bun, kept in
# ~/.openmods/toolchains with the versions harness builds pin; nothing
# outside ~/.openmods changes except the PATH line in your shell's startup
# files. Needs git, curl and tar.
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

# Bun caches the CLI's transpiled code; on Linux it would go in ~/.bun.
cat > "$OM/bin/openmods" <<WRAP
#!/bin/sh
OM="\${OPENMODS_HOME:-\$HOME/.openmods}"
export BUN_RUNTIME_TRANSPILER_CACHE_PATH="\${BUN_RUNTIME_TRANSPILER_CACHE_PATH-\$OM/cache/transpiler}"
exec "\$OM/toolchains/bun-$BUN_VERSION/bin/bun" "\$OM/registry/cli/src/index.ts" "\$@"
WRAP
chmod 755 "$OM/bin/openmods"

# PATH, and a launcher in front of each harness you have (see `openmods help setup`).
"$OM/bin/openmods" setup

echo "openmods is installed. Try: openmods list"
