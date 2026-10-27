# Claude Code transcript 항목 공용 정의. prev-turn.jq(훅)와 backfill.sh가 함께 쓴다.

def text: if (.message.content | type) == "string" then .message.content
          else ([.message.content[]? | select(.type == "text") | .text] | join("\n")) end;
def tool_result: (.message.content | type) == "array" and any(.message.content[]; .type == "tool_result");
def body: if (.content | type) == "string" then .content
          else ([.content[]? | select(.type == "text") | .text] | join(" ")) end;

# 내가 직접 친 입력: 도구 결과, 시스템 주입, 중단 표시, 서브에이전트는 아니다
def real_prompt: .type == "user" and (.isSidechain | not) and (.isMeta | not) and (.isCompactSummary | not)
  and (tool_result | not) and (text | length > 0)
  and (text | test("^\\s*(<(?!pasted_content)|\\[Request interrupted)") | not);

# 입력: transcript 항목 배열 (오래된 → 최신). 출력: 마지막 진짜 입력 이후 AI가 한 일.
def prev_turn:
  map(select(.isSidechain | not))
  | (to_entries | map(select(.value | real_prompt)) | last | .key // -1) as $i
  | .[$i + 1:]
  | {
      ai_text: ([.[] | select(.type == "assistant") | .message.content[]? | select(.type == "text") | .text] | join("\n\n")),
      proposals: ([.[] | select(.type == "assistant") | .message.content[]? | select(.type == "tool_use")
                   | {tool: .name, input: (.input | tostring | .[0:300])}] | .[-20:]),
      denied: [.[] | select(.type == "user") | .message.content[]? | select(.type == "tool_result" and .is_error == true)
               | body | select(test("doesn't want to proceed")) | .[0:800]],
      choices: [.[] | select(.type == "user" and (.toolUseResult | type) == "object" and (.toolUseResult | has("answers")))
                | .toolUseResult as $r | $r.questions[]?
                | {q: .question, options: [.options[]?.label], mine: ($r.answers[.question] // null)}],
      interrupted: any(.[]; .type == "user" and (text | startswith("[Request interrupted by user")))
    };
