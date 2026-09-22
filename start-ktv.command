#!/bin/sh

# Finder launches .command files with a minimal PATH, so also check the
# standard Homebrew locations and locally installed nvm versions.
cd "$(dirname "$0")" || exit 1

NODE_EXE="$(command -v node 2>/dev/null || true)"

if [ -z "$NODE_EXE" ]; then
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
    if [ -x "$candidate" ]; then
      NODE_EXE="$candidate"
      break
    fi
  done
fi

if [ -z "$NODE_EXE" ]; then
  for candidate in "$HOME"/.nvm/versions/node/*/bin/node; do
    if [ -x "$candidate" ]; then
      NODE_EXE="$candidate"
    fi
  done
fi

if [ -z "$NODE_EXE" ]; then
  echo
  echo "[錯誤] 找不到 Node.js。"
  echo "請先從 https://nodejs.org/ 安裝 Node.js 22 或更新版本，"
  echo "再重新雙擊 start-ktv.command。"
  echo
  printf "按 Return 關閉視窗..."
  read -r _
  exit 1
fi

echo "正在啟動 KTV..."
"$NODE_EXE" server.js
status=$?

echo
if [ "$status" -eq 0 ]; then
  echo "KTV 已停止。"
else
  echo "KTV 啟動失敗（錯誤代碼：$status）。"
fi
printf "按 Return 關閉視窗..."
read -r _
exit "$status"
