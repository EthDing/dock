#!/bin/sh
set -eu

REPOSITORY="EthDing/dock"
VERSION="${DOCK_VERSION:-}"
if [ "${1:-}" = "--version" ]; then
  [ -n "${2:-}" ] || { echo "dock: --version requires a value" >&2; exit 2; }
  VERSION="$2"
  shift 2
fi
[ "$#" -eq 0 ] || { echo "dock: unknown installer argument: $1" >&2; exit 2; }

[ "$(uname -s)" = "Linux" ] || { echo "dock: this installer currently supports Linux and WSL2" >&2; exit 1; }
for command in node curl tar sha256sum readlink; do
  command -v "$command" >/dev/null 2>&1 || { echo "dock: missing required command: $command" >&2; exit 1; }
done
NODE_MAJOR=$(node -p "Number(process.versions.node.split('.')[0])")
[ "$NODE_MAJOR" -ge 24 ] || { echo "dock: Node.js 24 or newer is required" >&2; exit 1; }

if [ -n "${DOCK_DOWNLOAD_BASE_URL:-}" ]; then
  BASE_URL=${DOCK_DOWNLOAD_BASE_URL%/}
elif [ -n "$VERSION" ]; then
  BASE_URL="https://github.com/$REPOSITORY/releases/download/v$VERSION"
else
  BASE_URL="https://github.com/$REPOSITORY/releases/latest/download"
fi

INSTALL_DIR=${DOCK_INSTALL_DIR:-"$HOME/.local/share/dock"}
BIN_DIR=${DOCK_BIN_DIR:-"$HOME/.local/bin"}
TEMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/dock-install.XXXXXX")
trap 'rm -rf -- "$TEMP_DIR"' EXIT HUP INT TERM

curl -fsSL "$BASE_URL/dock-linux.tar.gz" -o "$TEMP_DIR/dock-linux.tar.gz"
curl -fsSL "$BASE_URL/dock-linux.tar.gz.sha256" -o "$TEMP_DIR/dock-linux.tar.gz.sha256"
(
  cd "$TEMP_DIR"
  sha256sum -c dock-linux.tar.gz.sha256 >/dev/null
  mkdir package
  tar -xzf dock-linux.tar.gz -C package
)
[ -x "$TEMP_DIR/package/bin/dock" ] || { echo "dock: release archive is missing bin/dock" >&2; exit 1; }

mkdir -p "$(dirname "$INSTALL_DIR")" "$BIN_DIR"
NEXT_DIR="$INSTALL_DIR.next.$$"
OLD_DIR="$INSTALL_DIR.old.$$"
rm -rf -- "$NEXT_DIR" "$OLD_DIR"
mv "$TEMP_DIR/package" "$NEXT_DIR"
if [ -e "$INSTALL_DIR" ]; then mv "$INSTALL_DIR" "$OLD_DIR"; fi
if ! mv "$NEXT_DIR" "$INSTALL_DIR"; then
  [ ! -e "$OLD_DIR" ] || mv "$OLD_DIR" "$INSTALL_DIR"
  exit 1
fi
rm -rf -- "$OLD_DIR"
ln -sfn "$INSTALL_DIR/bin/dock" "$BIN_DIR/dock"

echo "Dock installed to $INSTALL_DIR"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "Add $BIN_DIR to PATH to run dock." ;;
esac
