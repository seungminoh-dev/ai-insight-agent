#!/bin/bash
# Claude Code UserPromptSubmit 훅 (async): 직전 턴에 AI가 한 일 + 내 이번 말을 한 쌍으로 Worker에 보낸다.
# 무엇이 실패해도 Claude Code에는 영향 없음 (백그라운드 실행, 항상 exit 0).
URL="${INSIGHT_URL:-$(cat ~/.config/insight/url 2>/dev/null)}"
TOKEN="$(cat ~/.config/insight/token 2>/dev/null)"
[ -n "$URL" ] && [ -n "$TOKEN" ] || exit 0

dir="$(dirname "$0")"
in="$(cat)"
tp="$(jq -r '.transcript_path // empty' <<<"$in")"
cur="$(jq -r '.prompt_id // empty' <<<"$in")"
prev='{}'
if [ -f "$tp" ]; then
  # ponytail: 마지막 3000줄만 본다. 그보다 긴 턴은 앞부분이 잘린다
  prev="$(tail -n 3000 "$tp" | jq -R -c 'fromjson? // empty' |
    jq -s -c -L "$dir" --arg cur "$cur" -f "$dir/prev-turn.jq" 2>/dev/null)" || prev='{}'
  [ -n "$prev" ] || prev='{}'
fi

# at: 백필이 원래 대화 시각을 넘길 때만 있다 (훅에서는 null → 서버가 지금 시각)
jq -c --argjson prev "$prev" '{prompt_id, session_id, cwd, prompt, at, prev: $prev}' <<<"$in" |
  curl -sS -m 15 -o /dev/null -X POST -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' --data-binary @- "$URL/ingest"
exit 0
