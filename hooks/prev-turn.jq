# 입력: transcript 항목 배열 (오래된 → 최신). 출력: 마지막 "진짜 내 입력" 이후 AI가 한 일.
# $cur: 지금 막 보낸 프롬프트의 prompt_id (이미 기록됐으면 제외)
include "turn";

map(select(.promptId != $cur)) | prev_turn
