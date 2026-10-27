#!/bin/bash
# 지난 Claude Code transcript를 훅과 똑같은 경로(insight.sh)로 한 번 흘려 넣는다.
# 이미 들어간 prompt_id는 서버가 무시하므로 여러 번 돌려도 된다.
set -euo pipefail
dir="$(cd "$(dirname "$0")" && pwd)"
prefix="$(mktemp)"
trap 'rm -f "$prefix"' EXIT
sent=0

while IFS= read -r -d '' f; do
  while IFS= read -r ev; do
    # 그 입력 직전까지만 잘라 주면 insight.sh가 훅 때와 같은 "직전 턴"을 본다
    head -n "$(($(jq -r .line <<<"$ev") - 1))" "$f" >"$prefix"
    jq -c --arg tp "$prefix" 'del(.line) + {transcript_path: $tp}' <<<"$ev" | "$dir/insight.sh"
    sent=$((sent + 1))
  done < <(jq -R -c -L "$dir" 'include "turn";
      fromjson? // empty | select(real_prompt and .timestamp != null)
      | {line: input_line_number, prompt_id: (.promptId // .uuid), session_id: .sessionId, cwd, prompt: text,
         at: (.timestamp | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601 * 1000)}' "$f")
done < <(find ~/.claude/projects -name '*.jsonl' -print0)

echo "sent $sent prompts"
