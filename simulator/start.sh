#!/usr/bin/env bash
set -euo pipefail

SIMULATOR_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "错误：未找到 Node.js。请先安装 Node.js 20 或更高版本。" >&2
  exit 1
fi

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if (( NODE_MAJOR < 20 )); then
  echo "错误：当前 Node.js 版本为 $(node --version)，需要 20 或更高版本。" >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "错误：未找到 npm。" >&2
  exit 1
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "提示：未找到 ffmpeg，MQTT 模拟仍可运行，但 UDP H.265 图传不可用。" >&2
  echo "Ubuntu 可执行：sudo apt install ffmpeg" >&2
fi

cd "${SIMULATOR_DIR}"

# v2 使用 pnpm-lock.yaml；上游的 npm ci 需要 package-lock.json，直接照搬会在
# Ubuntu 上报 “npm ci can only install with an existing package-lock.json”。
if [[ ! -d node_modules ]]; then
  echo "正在安装独立模拟器依赖……"
  if command -v pnpm >/dev/null 2>&1 && [[ -f pnpm-lock.yaml ]]; then
    pnpm install --frozen-lockfile
  else
    npm install
  fi
fi

exec node src/server.js "$@"
