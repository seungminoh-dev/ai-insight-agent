import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

export type Pair = {
  prompt_id: string;
  session_id: string;
  cwd: string | null;
  my_text: string;
  quoted: string | null;
  ai_text: string | null;
  ai_actions: string | null;
  at: number;
  done: number;
};
type Actions = {
  proposals?: { tool: string; input: string }[];
  denied?: string[];
  choices?: { q: string; options: string[]; mine: string | null }[];
  interrupted?: boolean;
};

// ── 수집: 내 말만 남기기 ─────────────────────────────────────

const PASTED = /<pasted_content[^>]*>([\s\S]*?)<\/pasted_content[^>]*>/g;
const SECRETS = [
  /\bsk-[\w-]{20,}/g,
  /\bgh[pousr]_\w{30,}/g,
  /\bgithub_pat_\w{30,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abpr]-[\w-]{10,}/g,
  /\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];
export const redact = (s: string) => SECRETS.reduce((t, re) => t.replace(re, "[REDACTED]"), s);

/** 명령어·시스템 메시지면 null. 붙여넣기는 quoted로 떼어 낸다: 문맥이지 내 주장이 아니다. */
export function splitPrompt(prompt: string): { mine: string; quoted: string } | null {
  const p = prompt.trim();
  // ponytail: '<'로 시작하는 내 글(HTML을 바로 쓰는 경우)도 버려진다
  if (!p || /^[\/!]/.test(p) || /^<(?!pasted_content)[\w-]+[\s>]/.test(p)) return null;
  const quoted: string[] = [];
  const mine = p.replace(PASTED, (_, body: string) => (quoted.push(body.trim()), "")).trim();
  return { mine, quoted: quoted.join("\n---\n") };
}

// ── 검증: LLM 출력을 믿지 않는다 ─────────────────────────────

export const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const has = (hay: string | null | undefined, needle: string | null | undefined) =>
  !!hay && !!needle && norm(hay).includes(norm(needle));
export const actionsOf = (p: Pair): Actions => {
  try {
    return JSON.parse(p.ai_actions || "{}");
  } catch {
    return {};
  }
};

export const Item = z.object({
  pair: z.string(),
  kind: z.enum(["value", "principle", "preference", "belief", "rejection"]),
  reaction: z.enum(["spontaneous", "agree", "disagree", "refine", "articulated", "interrupt", "tool_denied", "choice"]),
  statement: z.string(),
  seed: z.string(),
  expression: z.string().nullable(),
  ai_proposal: z.string().nullable(),
  reason: z.string().nullable(),
  theme_id: z.number().int().nullable(),
  new_theme: z.string().nullable(),
  confidence: z.number(),
});
export type Item = z.infer<typeof Item>;
const Output = z.object({ items: z.array(Item) });

/** 인용은 실제 원문에 있어야 하고, 구조적 거절(중단·도구 거절·다른 선택)은 실제 신호가 있어야 남긴다. */
export function verify(items: Item[], pending: Map<string, Pair>) {
  return items.flatMap((i) => {
    const p = pending.get(i.pair);
    if (!p || i.confidence < 0.6) return [];
    const a = actionsOf(p);
    const mine = [p.my_text, ...(a.choices ?? []).map((c) => c.mine ?? ""), ...(a.denied ?? [])].join("\n");
    const signals: Record<string, boolean> = {
      interrupt: !!a.interrupted,
      tool_denied: !!a.denied?.length,
      choice: !!a.choices?.some((c) => c.mine && c.mine !== c.options[0]),
    };
    const signal = signals[i.reaction];
    if (signal === false) return [];
    if (!(signal && !i.seed) && !has(mine, i.seed)) return []; // 말 없는 중단·선택만 seed 생략 가능
    if (i.seed.length >= 15 && has(p.ai_text, i.seed)) return []; // AI 문장을 되받아쓴 것
    if (i.reaction === "articulated" && !has(p.ai_text, i.expression)) return [];
    return [{ ...i, p }];
  });
}

export async function resolveTheme(db: D1Database, themeId?: number | null, newTheme?: string | null) {
  if (themeId != null && (await db.prepare("SELECT 1 FROM themes WHERE id = ?").bind(themeId).first())) return themeId;
  if (!newTheme?.trim()) return null;
  const row = await db
    .prepare(
      "INSERT INTO themes (statement, at) VALUES (?, ?) ON CONFLICT (statement) DO UPDATE SET statement = excluded.statement RETURNING id",
    )
    .bind(newTheme.trim(), Date.now())
    .first<{ id: number }>();
  return row?.id ?? null;
}

// ── 추출: cron ──────────────────────────────────────────────

const SYSTEM = `너는 한 사람('나')과 AI 코딩 어시스턴트(Claude Code)의 대화 기록에서 '나'의 생각과 'AI 제안 → 나의 거절'을 뽑는다.

입력은 시간순 쌍이다. 각 쌍은 직전 AI 행동과 그 뒤 나의 말이다.
- <ai>: 직전 턴에 AI가 한 말 (뒷부분)
- <ai_actions>: AI의 도구 제안, 내가 거절한 도구 실행(내가 적은 이유 포함), AI 질문과 선택지·내 답, 내가 중단했는지
- <me>: 내가 직접 쓴 말
- <quoted>: 내가 붙여넣은 글. 문맥으로만 보고 내 주장으로 삼지 않는다
- <themes>: 이미 정리된 나의 원칙 목록
- [C…] 쌍은 문맥용이다. 항목은 [P…] 쌍에서만 뽑는다.

뽑을 것
1. 내 생각 — kind: value(가치) | principle(원칙) | preference(선호) | belief(신념)
   reaction: spontaneous(내가 먼저 말함) | agree(이유를 붙여 동의) | disagree(AI 주장에 반대) | refine(AI 주장을 고쳐 받음) | articulated(내 의문·직관을 AI가 표현으로 정리했고 내가 그 위에서 이어감)
2. 거절 — kind: rejection
   reaction: disagree(말로 반박) | interrupt(중단) | tool_denied(도구 실행 거절) | choice(AI 추천 선택지 대신 다른 답)
   ai_proposal: AI가 하려던 것 한 줄. reason: 이유가 드러날 때만.

규칙
- seed는 <me>, 내 답, 내가 적은 거절 이유에서 글자 그대로 복사한다. 고치거나 줄이지 않는다. 말 없이 중단·선택만 했으면 ""로 둔다.
- articulated의 expression은 <ai>에서 글자 그대로 복사한다.
- AI의 말을 내 생각으로 옮기지 않는다. "ㅇㅇ", "좋아", "진행해" 같은 단순 수락과 질문만 한 것은 뽑지 않는다.
- 작업 지시("이거 고쳐줘")는 뽑지 않는다. 지시에 기준이 드러나면 preference로 뽑는다(예: "라이브러리 추가하지 말고 표준으로").
- 사실·일정·상황 설명은 뽑지 않는다.
- statement: 내 생각은 "나는 …" 꼴, 거절은 "AI의 … 제안을 … 거절" 꼴의 한국어 한 문장.
- <themes>에 같은 생각이 있으면 theme_id, 반복될 만한 새 원칙이면 new_theme(짧은 문장), 아니면 둘 다 null.
- "항상", "원래", "예전에도" 같은 말은 반복 신호다.
- 근거가 약하면 confidence를 낮춘다. 뽑을 게 없으면 items는 빈 배열.`;

const base = (cwd: string | null) => cwd?.split("/").filter(Boolean).pop() ?? "";
const tail = (s: string, n: number) => (s.length > n ? "…" + s.slice(-n) : s);

export function render(label: string, p: Pair): string {
  const a = actionsOf(p);
  const acts = [
    ...(a.proposals ?? []).map((t) => `도구 제안: ${t.tool} ${t.input}`),
    ...(a.denied ?? []).map((d) => `내가 거절한 도구 실행: ${d}`),
    ...(a.choices ?? []).map(
      (c) => `AI 질문: ${c.q} / 선택지(첫 번째가 AI 추천): ${c.options.join(" | ")} / 내 답: ${c.mine ?? "(없음)"}`,
    ),
    ...(a.interrupted ? ["내가 중단(Esc)함"] : []),
  ];
  return [
    `[${label}] ${new Date(p.at).toISOString().slice(0, 16)} ${base(p.cwd)}`,
    p.ai_text ? `<ai>${tail(p.ai_text, 3000)}</ai>` : "",
    acts.length ? `<ai_actions>\n${acts.join("\n")}\n</ai_actions>` : "",
    `<me>${p.my_text}</me>`,
    p.quoted ? `<quoted>${p.quoted.slice(0, 1500)}</quoted>` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** force: 20분 대기 없이 지금 처리 (대시보드 "지금 추출"). session: 그 세션만. */
export async function extract(env: Env, opts: { force?: boolean; session?: string } = {}) {
  const stats = { batches: 0, saved: 0 };
  if (!env.ANTHROPIC_API_KEY) return stats;
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const deadline = Date.now() + 10 * 60_000; // ponytail: 1회 10분까지, 남은 건 다음 회차
  const quietSince = opts.force ? Date.now() + 1 : Date.now() - 20 * 60_000; // 평소엔 20분 조용해진 세션만
  const { results: sessions } = await env.DB.prepare(
    `SELECT session_id FROM pairs WHERE ?2 IS NULL OR session_id = ?2
     GROUP BY session_id HAVING SUM(done = 0) > 0 AND MAX(at) < ?1 ORDER BY MAX(at)`,
  )
    .bind(quietSince, opts.session ?? null)
    .all<{ session_id: string }>();
  for (const { session_id } of sessions) {
    while (Date.now() < deadline) {
      const { results: batch } = await env.DB.prepare(
        "SELECT * FROM pairs WHERE session_id = ? AND done = 0 ORDER BY at LIMIT 20",
      )
        .bind(session_id)
        .all<Pair>();
      if (!batch.length) break;
      try {
        stats.saved += await extractBatch(env, client, batch);
        stats.batches++;
      } catch (e) {
        console.error("extract failed, retrying next run", session_id, e);
        break;
      }
    }
  }
  return stats;
}

async function extractBatch(env: Env, client: Anthropic, batch: Pair[]) {
  const db = env.DB;
  const { results: ctx } = await db
    .prepare("SELECT * FROM pairs WHERE session_id = ? AND done = 1 AND at < ? ORDER BY at DESC LIMIT 2")
    .bind(batch[0].session_id, batch[0].at)
    .all<Pair>();
  const { results: themes } = await db
    .prepare("SELECT id, statement FROM themes ORDER BY id")
    .all<{ id: number; statement: string }>();
  const pending = new Map(batch.map((p, n) => [`P${n + 1}`, p] as const));
  const prompt = [
    `<themes>\n${themes.map((t) => `${t.id}. ${t.statement}`).join("\n") || "(없음)"}\n</themes>`,
    ...ctx.reverse().map((p, n) => render(`C${n + 1}`, p)),
    ...[...pending].map(([label, p]) => render(label, p)),
  ].join("\n\n");

  const res = await client.beta.messages.parse({
    model: env.MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "medium", format: betaZodOutputFormat(Output) },
    system: SYSTEM,
    messages: [{ role: "user", content: prompt }],
  });
  // 거절·잘림·파싱 실패는 다시 돌려도 같으니 기록만 하고 완료 처리
  if (res.stop_reason !== "end_turn" || !res.parsed_output) console.warn("extract: no usable output", res.stop_reason);
  const kept = verify(res.parsed_output?.items ?? [], pending);

  const writes: D1PreparedStatement[] = [];
  for (const i of kept) {
    const themeId = await resolveTheme(db, i.theme_id, i.new_theme);
    writes.push(
      db
        .prepare(
          `INSERT INTO insights (source, prompt_id, session_id, project, kind, reaction, statement, seed, expression, ai_proposal, reason, theme_id, confidence, at)
           VALUES ('code', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(i.p.prompt_id, i.p.session_id, base(i.p.cwd), i.kind, i.reaction, i.statement, i.seed, i.expression, i.ai_proposal, i.reason, themeId, i.confidence, i.p.at),
    );
  }
  writes.push(
    db
      .prepare(`UPDATE pairs SET done = 1 WHERE prompt_id IN (${batch.map(() => "?").join(", ")})`)
      .bind(...batch.map((p) => p.prompt_id)),
  );
  await db.batch(writes);
  return kept.length;
}
