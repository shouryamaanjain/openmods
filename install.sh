#!/bin/sh
# Installs the openmods CLI: a clone of the registry under ~/.openmods and
# an `openmods` command in ~/.openmods/bin, which install also puts first
# on your PATH. Needs git; installs Bun for the CLI if it is missing.
#
#   curl -fsSL https://openmods.dev/install.sh | sh
set -e

OM="${OPENMODS_HOME:-$HOME/.openmods}"
REG="${OPENMODS_REGISTRY:-https://github.com/shouryamaanjain/openmods}"

command -v git >/dev/null 2>&1 || { echo "openmods needs git. Install it and run this again."; exit 1; }

if ! command -v bun >/dev/null 2>&1; then
  echo "Installing Bun for the CLI (your harness builds use the version each release pins, installed separately)."
  curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1 || { echo "Could not install Bun. Install it from https://bun.sh and run this again."; exit 1; }
  export PATH="$HOME/.bun/bin:$PATH"
fi

mkdir -p "$OM/bin"
if [ -d "$OM/registry/.git" ]; then
  git -C "$OM/registry" pull -q --ff-only || true
else
  case "$REG" in
    http*|git@*|ssh://*) git clone -q --depth 1 "$REG" "$OM/registry" ;;
    *) git clone -q "$REG" "$OM/registry" ;;
  esac
fi

cat > "$OM/bin/openmods" <<'WRAP'
#!/bin/sh
OM="${OPENMODS_HOME:-$HOME/.openmods}"
BUN=$(command -v bun 2>/dev/null || echo "$HOME/.bun/bin/bun")
exec "$BUN" "$OM/registry/cli/src/index.ts" "$@"
WRAP
chmod 755 "$OM/bin/openmods"

case ":$PATH:" in
  *":$OM/bin:"*) ;;
  *)
    SHELL_NAME=$(basename "${SHELL:-sh}")
    case "$SHELL_NAME" in
      zsh) RC="$HOME/.zshrc" ;;
      fish) RC="$HOME/.config/fish/config.fish" ;;
      *) if [ "$(uname)" = "Darwin" ]; then RC="$HOME/.bash_profile"; else RC="$HOME/.bashrc"; fi ;;
    esac
    if ! grep -q "# openmods" "$RC" 2>/dev/null; then
      mkdir -p "$(dirname "$RC")"
      if [ "$SHELL_NAME" = "fish" ]; then
        printf '\n# openmods: modded builds go first; `openmods off` steps aside\nfish_add_path --prepend --move %s  # openmods\n' "$OM/bin" >> "$RC"
      else
        printf '\n# openmods: modded builds go first; `openmods off` steps aside\nexport PATH="%s:$PATH"  # openmods\n' "$OM/bin" >> "$RC"
      fi
      echo "Added $OM/bin to PATH in $RC. Open a new terminal, or run:"
      echo "  export PATH=\"$OM/bin:\$PATH\""
    fi ;;
esac

echo "openmods is installed. Try: openmods list"
