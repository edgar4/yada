#!/bin/sh
set -eu

repo="edgar4/yada"
version="${1:-${YADA_VERSION:-latest}}"
dir="${YADA_INSTALL_DIR:-$HOME/.local/bin}"

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) echo "Unsupported system: $(uname -s). On Windows, use install.ps1." >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) echo "Unsupported CPU: $(uname -m)" >&2; exit 1 ;;
esac
if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
  arch=arm64
fi

asset="yada-$os-$arch.tar.gz"
if [ "$version" = latest ]; then
  base="https://github.com/$repo/releases/latest/download"
else
  base="https://github.com/$repo/releases/download/v${version#v}"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
download() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"
  else wget -qO "$2" "$1"; fi
}
download "$base/$asset" "$tmp/$asset"
download "$base/SHA256SUMS" "$tmp/SHA256SUMS"

expected="$(grep " $asset\$" "$tmp/SHA256SUMS" | cut -d ' ' -f 1)"
if command -v sha256sum >/dev/null 2>&1; then actual="$(sha256sum "$tmp/$asset" | cut -d ' ' -f 1)"
else actual="$(shasum -a 256 "$tmp/$asset" | cut -d ' ' -f 1)"; fi
if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
  echo "Checksum mismatch for $asset" >&2
  exit 1
fi

tar -xzf "$tmp/$asset" -C "$tmp"
mkdir -p "$dir"
mv "$tmp/yada" "$dir/yada"
chmod 755 "$dir/yada"
echo "Installed yada $("$dir/yada" --version) to $dir/yada"
case ":$PATH:" in
  *":$dir:"*) ;;
  *) echo "Add $dir to your PATH: echo 'export PATH=\"$dir:\$PATH\"' >> ~/.profile" ;;
esac
