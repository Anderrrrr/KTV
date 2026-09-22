#!/bin/sh

# Finder launches .command files with a minimal PATH, and different Macs
# have different Node.js versions installed in different places (system
# PATH, Homebrew, nvm, ...). This script checks every candidate's actual
# version and picks the newest one that satisfies the app's requirement
# (Node >= 22.5, needed for the built-in node:sqlite module), instead of
# blindly using whichever "node" happens to be found first.
cd "$(dirname "$0")" || exit 1

REQUIRED_MAJOR=22
REQUIRED_MINOR=5
REQUIRED_SCORE=$((REQUIRED_MAJOR * 1000000 + REQUIRED_MINOR * 1000))

NODE_EXE=""
BEST_SCORE=-1

version_score() {
  ver=$("$1" -v 2>/dev/null) || { echo -1; return; }
  ver=${ver#v}
  major=${ver%%.*}
  rest=${ver#*.}
  minor=${rest%%.*}
  rest2=${rest#*.}
  patch=${rest2%%.*}
  case "$major" in ''|*[!0-9]*) echo -1; return ;; esac
  case "$minor" in ''|*[!0-9]*) minor=0 ;; esac
  case "$patch" in ''|*[!0-9]*) patch=0 ;; esac
  echo $((major * 1000000 + minor * 1000 + patch))
}

consider() {
  candidate="$1"
  [ -x "$candidate" ] || return
  score=$(version_score "$candidate")
  [ "$score" -ge "$REQUIRED_SCORE" ] 2>/dev/null || return
  if [ "$score" -gt "$BEST_SCORE" ]; then
    BEST_SCORE="$score"
    NODE_EXE="$candidate"
  fi
}

if command -v node >/dev/null 2>&1; then
  consider "$(command -v node)"
fi
for candidate in /opt/homebrew/bin/node /usr/local/bin/node \
    /opt/homebrew/opt/node@*/bin/node /usr/local/opt/node@*/bin/node \
    "$HOME"/.nvm/versions/node/*/bin/node; do
  consider "$candidate"
done

if [ -z "$NODE_EXE" ]; then
  echo
  echo "[錯誤] 找不到 Node.js $REQUIRED_MAJOR.$REQUIRED_MINOR 以上的版本。"
  echo "請先從 https://nodejs.org/ 安裝 Node.js 22 或更新版本，"
  echo "再重新雙擊 start-ktv.command。"
  echo
  printf "按 Return 關閉視窗..."
  read -r _
  exit 1
fi

# NOTE: macOS's bundled bash 3.2 (used by both /bin/sh and /bin/bash) can
# corrupt output when a variable expansion sits directly next to a
# full-width CJK punctuation mark in the same quoted string, so the
# dynamic values below are passed as separate printf arguments instead.
node_version=$("$NODE_EXE" -v)
printf '正在啟動 KTV...（使用 %s：%s）\n' "$node_version" "$NODE_EXE"
"$NODE_EXE" server.js
status=$?

echo
if [ "$status" -eq 0 ]; then
  echo "KTV 已停止。"
else
  printf 'KTV 啟動失敗（錯誤代碼：%s）。\n' "$status"
fi
printf "按 Return 關閉視窗..."
read -r _
exit "$status"
