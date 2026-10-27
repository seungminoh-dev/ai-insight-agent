import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { redact, splitPrompt, verify, type Item, type Pair } from "../src/extract.ts";

const pair = (o: Partial<Pair> = {}): Pair => ({
  prompt_id: "p1",
  session_id: "s1",
  cwd: "/Users/me/proj",
  my_text: "추상화 레이어를 두면 확장성이 좋아진다고 했는데 아니야, 구현 두 개 생기기 전엔 인터페이스 안 만들어",
  quoted: null,
  ai_text: "추상화 레이어를 두면 확장성이 좋아진다고 봅니다. 즉, 단순함을 중시하시는군요.",
  ai_actions: "{}",
  at: 0,
  done: 0,
  ...o,
});
const item = (o: Partial<Item> = {}): Item => ({
  pair: "P1",
  kind: "principle",
  reaction: "disagree",
  statement: "나는 구현이 두 개 생기기 전엔 인터페이스를 만들지 않는다",
  seed: "구현 두 개 생기기 전엔 인터페이스 안 만들어",
  expression: null,
  ai_proposal: null,
  reason: null,
  theme_id: null,
  new_theme: null,
  confidence: 0.9,
  ...o,
});
const kept = (i: Item, p = pair()) => verify([i], new Map([["P1", p]])).length;

test("verify: 내 원문에 있는 것만 남긴다", () => {
  assert.equal(kept(item()), 1);
  assert.equal(kept(item({ seed: "단순함을 중시하시는군요" })), 0); // AI 문장
  assert.equal(kept(item({ seed: "추상화 레이어를 두면 확장성이 좋아진다고" })), 0); // 내 글에 있지만 AI 말을 되받아쓴 것
  assert.equal(kept(item({ confidence: 0.3 })), 0);
  assert.equal(kept(item({ pair: "C1" })), 0); // 문맥용 쌍
});

test("verify: 정리됨은 AI 표현도 원문에 있어야 한다", () => {
  assert.equal(kept(item({ reaction: "articulated", expression: "단순함을 중시하시는군요" })), 1);
  assert.equal(kept(item({ reaction: "articulated", expression: "AI가 하지 않은 말" })), 0);
});

test("verify: 중단·다른 선택은 실제 신호가 있어야 한다", () => {
  const stop = item({ kind: "rejection", reaction: "interrupt", seed: "" });
  assert.equal(kept(stop), 0);
  assert.equal(kept(stop, pair({ ai_actions: JSON.stringify({ interrupted: true }) })), 1);

  const choices = [{ q: "어떻게 할까요?", options: ["A (Recommended)", "B"], mine: "둘 다 아니고 C" }];
  const choice = item({ kind: "rejection", reaction: "choice", seed: "둘 다 아니고 C" });
  assert.equal(kept(choice, pair({ ai_actions: JSON.stringify({ choices }) })), 1);
  const tookFirst = [{ ...choices[0], mine: "A (Recommended)" }];
  assert.equal(kept(choice, pair({ ai_actions: JSON.stringify({ choices: tookFirst }) })), 0);
});

test("splitPrompt: 명령어·시스템 메시지는 버리고 붙여넣기는 떼어 낸다", () => {
  assert.equal(splitPrompt("/ponytail lite"), null);
  assert.equal(splitPrompt("<task-notification>done</task-notification>"), null);
  assert.deepEqual(splitPrompt('<pasted_content id="1">\nAI 답변\n</pasted_content id="1">\n이거 맞아?'), {
    mine: "이거 맞아?",
    quoted: "AI 답변",
  });
});

test("redact", () => {
  assert.equal(redact("key sk-ant-api03-abcdefghijklmnopqrstuvwxyz"), "key [REDACTED]");
});

test("prev-turn.jq: 마지막 내 입력 이후 AI가 한 일을 모은다", () => {
  const lines = [
    { type: "user", promptId: "a", message: { content: "설정 정리해줘" } },
    { type: "assistant", message: { content: [{ type: "text", text: "config.ts를 고치겠습니다" }, { type: "tool_use", name: "Edit", input: { file_path: "config.ts" } }] } },
    { type: "user", promptId: "a", message: { content: [{ type: "tool_result", is_error: true, content: "The user doesn't want to proceed with this tool use. 그 파일은 건드리지 마" }] } },
    { type: "user", promptId: "a", message: { content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] } },
    { type: "user", promptId: "a", toolUseResult: { questions: [{ question: "Q", options: [{ label: "A (Recommended)" }, { label: "B" }] }], answers: { Q: "B" } }, message: { content: [{ type: "tool_result", content: "answered" }] } },
    { type: "assistant", isSidechain: true, message: { content: [{ type: "text", text: "서브에이전트 말" }] } },
    { type: "user", promptId: "b", message: { content: "아니 그건 하지 마" } }, // 지금 보낸 프롬프트
  ];
  const out = JSON.parse(
    execFileSync("jq", ["-s", "-c", "-L", "hooks", "--arg", "cur", "b", "-f", "hooks/prev-turn.jq"], {
      input: lines.map((l) => JSON.stringify(l)).join("\n"),
    }).toString(),
  );
  assert.equal(out.ai_text, "config.ts를 고치겠습니다");
  assert.equal(out.proposals[0].tool, "Edit");
  assert.match(out.denied[0], /건드리지 마/);
  assert.deepEqual(out.choices, [{ q: "Q", options: ["A (Recommended)", "B"], mine: "B" }]);
  assert.equal(out.interrupted, true);
});
