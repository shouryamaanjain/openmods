#!/bin/sh
# Installs the open-mods CLI: a clone of the registry under ~/.open-mods and
# an `open-mods` command in ~/.open-mods/bin, which install also puts first
# on your PATH. Needs git; installs Bun for the CLI if it is missing.
#
#   curl -fsSL https://openmods.dev/install.sh | sh
set -e

OM="${OPEN_MODS_HOME:-$HOME/.open-mods}"
REG="${OPEN_MODS_REGISTRY:-https://github.com/shouryamaanjain/open-mods}"

command -v git >/dev/null 2>&1 || { echo "open-mods needs git. Install it and run this again."; exit 1; }

if ! command -v bun >/dev/null 2>&1; then
  echo "Installing Bun for the CLI (your harness builds use the version each release pins, installed separately)."
  curl -fsSL https://bun.sh/install | bash >/dev/null
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

cat > "$OM/bin/open-mods" <<'WRAP'
#!/bin/sh
OM="${OPEN_MODS_HOME:-$HOME/.open-mods}"
BUN=$(command -v bun 2>/dev/null || echo "$HOME/.bun/bin/bun")
exec "$BUN" "$OM/registry/cli/src/index.ts" "$@"
WRAP
chmod 755 "$OM/bin/open-mods"

case ":$PATH:" in
  *":$OM/bin:"*) ;;
  *)
    SHELL_NAME=$(basename "${SHELL:-sh}")
    case "$SHELL_NAME" in
      zsh) RC="$HOME/.zshrc" ;;
      fish) RC="$HOME/.config/fish/config.fish" ;;
      *) if [ "$(uname)" = "Darwin" ]; then RC="$HOME/.bash_profile"; else RC="$HOME/.bashrc"; fi ;;
    esac
    if ! grep -q "# open-mods" "$RC" 2>/dev/null; then
      mkdir -p "$(dirname "$RC")"
      if [ "$SHELL_NAME" = "fish" ]; then
        printf '\n# open-mods: modded builds go first; `open-mods off` steps aside\nfish_add_path --prepend --move %s  # open-mods\n' "$OM/bin" >> "$RC"
      else
        printf '\n# open-mods: modded builds go first; `open-mods off` steps aside\nexport PATH="%s:$PATH"  # open-mods\n' "$OM/bin" >> "$RC"
      fi
      echo "Added $OM/bin to PATH in $RC. Open a new terminal, or run:"
      echo "  export PATH=\"$OM/bin:\$PATH\""
    fi ;;
esac

echo "open-mods is installed. Try: open-mods list"
