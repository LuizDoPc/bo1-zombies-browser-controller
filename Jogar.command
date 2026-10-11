#!/bin/bash
set -e
cd "$(dirname "$0")"
trap 'printf "\nNao foi possivel iniciar. Confira a mensagem acima e tente abrir novamente.\n"; read -r -p "Pressione Enter para fechar... "' ERR
mkdir -p .runtime
case "$(uname -m)" in
  arm64) target=aarch64-apple-darwin; digest=a9c1b29002cf3c83f07fa9cd8a887a3be0107d90e23189721221e7257db8e3d6 ;;
  x86_64) target=x86_64-apple-darwin; digest=5f44dcbde809b632f47c36fadb241cb4d6f9af71d0c8f172b5d2026d3dde742c ;;
  *) echo 'Este iniciador precisa de um Mac Intel ou Apple Silicon.'; exit 1 ;;
esac
uv=".runtime/uv-$target/uv"
if [ ! -x "$uv" ]; then
  echo 'Preparando o iniciador pela primeira vez...'
  curl --fail --location --retry 3 --output .runtime/uv.tar.gz "https://github.com/astral-sh/uv/releases/download/0.13.0/uv-$target.tar.gz"
  actual=$(shasum -a 256 .runtime/uv.tar.gz | cut -d ' ' -f 1)
  [ "$actual" = "$digest" ] || { echo 'O download do iniciador falhou na verificacao.'; exit 1; }
  tar -xzf .runtime/uv.tar.gz -C .runtime
  rm .runtime/uv.tar.gz
fi
export UV_PYTHON_INSTALL_DIR="$PWD/.runtime/python"
export UV_CACHE_DIR="$PWD/.runtime/cache"
export UV_PYTHON_PREFERENCE=only-managed
"$uv" run --no-project --python 3.12 python launcher.py "$@"
