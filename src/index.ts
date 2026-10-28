import { WorkerEntrypoint, env as bindings } from "cloudflare:workers";
import {
  AuthorizationError,
  CimdFetchError,
  OAuthProvider,
  authorizationErrorRedirect,
  type AuthRequest,
  type ConsentDescription,
} from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import dashboard from "./dashboard.html";
import { extract, redact, resolveTheme, splitPrompt } from "./extract";

const SESSION = "__Host-insight_session";
const STATE = "__Host-insight_state";
const MONTH = 30 * 86_400;
const COOKIE = "Path=/; Secure; HttpOnly; SameSite=Lax";
const enc = new TextEncoder();

// ── MCP: claude.ai·Claude Code에서 "정리" → 초안 → OK → 저장 ───────────

const INSTRUCTIONS = `대화에서 사용자('나')의 생각을 인사이트로 남기는 도구다.
- 사용자가 "정리"·"저장"이라고 하거나, 사용자의 의문이 대화를 거쳐 결론에 닿았다고 보이면 대화당 한 번 초안을 제안한다.
- 초안 전에 find_themes로 기존 원칙을 확인하고, 같은 생각이면 연결한다(몇 번째 등장인지 표시).
- 초안: 한 문장 + 사용자 원문(seed) + AI 표현(있으면) + 연결 테마. 출처를 섞지 않는다. 여러 개면 번호를 붙인다.
- 사용자가 OK하면 save_insight. "1, 3만", "2는 이렇게" 같은 답은 반영해 다시 확인한다. 답이 없으면 저장하지 않는다.
- AI가 혼자 한 주장은 사용자 인사이트가 아니다. 사용자의 씨앗(의문·직관·반박)이 있어야 한다.
- AI 제안을 사용자가 거절한 흐름도 kind=rejection으로 남길 수 있다.`;

function mcpServer() {
  const server = new McpServer({ name: "insight", version: "1.0.0" }, { instructions: INSTRUCTIONS });
  server.registerTool(
    "find_themes",
    {
      description: "내가 이미 가진 원칙(테마)과 등장 횟수를 찾는다. 인사이트 초안을 만들기 전에 불러 반복되는 생각과 연결한다.",
      inputSchema: { query: z.string().optional().describe("찾을 말. 비우면 많이 나온 순으로 전체") },
    },
    async ({ query }) => {
      const { results } = await bindings.DB.prepare(
        `SELECT t.id, t.statement, COUNT(i.id) AS count, MAX(i.at) AS last_at
         FROM themes t LEFT JOIN insights i ON i.theme_id = t.id AND i.status != 'dismissed'
         WHERE ?1 IS NULL OR t.statement LIKE '%' || ?1 || '%'
         GROUP BY t.id ORDER BY count DESC, last_at DESC LIMIT 50`,
      )
        .bind(query?.trim() || null)
        .all();
      return { content: [{ type: "text", text: JSON.stringify(results) }] };
    },
  );
  server.registerTool(
    "save_insight",
    {
      description:
        "인사이트를 저장한다. 사용자가 초안을 보고 명시적으로 OK한 뒤에만 부른다. seed는 사용자 메시지 원문을 글자 그대로 복사한다(다듬지 않는다).",
      inputSchema: {
        statement: z.string().describe("최종안 한 문장"),
        kind: z.enum(["value", "principle", "preference", "belief", "rejection"]),
        reaction: z.enum(["spontaneous", "agree", "disagree", "refine", "articulated"]),
        seed: z.string().describe("사용자 메시지 원문 그대로"),
        expression: z.string().optional().describe("articulated일 때 AI가 정리한 표현 원문"),
        ai_proposal: z.string().optional().describe("사용자가 반박·거절한 AI 제안"),
        reason: z.string().optional(),
        theme_id: z.number().int().optional().describe("find_themes에서 고른 기존 테마"),
        new_theme: z.string().optional().describe("새 원칙으로 묶을 때 짧은 문장"),
        context: z.string().describe("무슨 대화였는지 한 줄"),
      },
    },
    async (a) => {
      const themeId = await resolveTheme(bindings.DB, a.theme_id, a.new_theme);
      const row = await bindings.DB.prepare(
        `INSERT INTO insights (source, kind, reaction, statement, seed, expression, ai_proposal, reason, context, theme_id, status, at)
         VALUES ('mcp', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?) RETURNING id`,
      )
        .bind(a.kind, a.reaction, a.statement, a.seed, a.expression ?? null, a.ai_proposal ?? null, a.reason ?? null, a.context, themeId, Date.now())
        .first<{ id: number }>();
      return { content: [{ type: "text", text: `저장됨 #${row?.id}` }] };
    },
  );
  return server;
}

// ── 라우팅 ────────────────────────────────────────────────────

async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  try {
    switch (url.pathname) {
      case "/ingest":
        return await ingest(req, env);
      case "/authorize":
        return await (req.method === "POST" ? approve(req, env) : authorize(req, env));
      case "/callback": // GitHub OAuth App의 callback은 하나: 대시보드 로그인은 우리 state 쿠키로 구분
        return await (url.searchParams.get("state") === cookie(req, STATE) ? dashboardCallback(req, env) : mcpCallback(req, env));
      case "/login":
        return login(url, env);
      case "/logout":
        return redirect("/", { "Set-Cookie": `${SESSION}=; ${COOKIE}; Max-Age=0` });
      case "/api/extract": // 대시보드 버튼 또는 훅 토큰: 결과 수만 돌려준다
        if (req.method !== "POST" || !(isIngest(req, env) || (await signedIn(req, env))))
          return new Response("unauthorized", { status: 401 });
        return Response.json(await extract(env, { force: true, session: url.searchParams.get("session") ?? undefined }));
    }
    if (!(await signedIn(req, env)))
      return url.pathname.startsWith("/api/") ? new Response("unauthorized", { status: 401 }) : redirect("/login");
    if (url.pathname === "/")
      return new Response(dashboard, { headers: { "Content-Type": "text/html; charset=utf-8", "X-Frame-Options": "DENY" } });
    return await api(req, env, url);
  } catch (e) {
    if (e instanceof AuthorizationError && e.redirectTo) return Response.redirect(e.redirectTo, 302);
    if (e instanceof AuthorizationError || e instanceof CimdFetchError)
      return new Response(e instanceof AuthorizationError ? e.description : "client could not be verified", { status: 400 });
    throw e;
  }
}

// ── 수집: Claude Code 훅 ──────────────────────────────────────

const isIngest = (req: Request, env: Env) => safeEqual(req.headers.get("Authorization") ?? "", `Bearer ${env.INGEST_TOKEN}`);

async function ingest(req: Request, env: Env) {
  if (req.method !== "POST" || !isIngest(req, env)) return new Response("unauthorized", { status: 401 });
  const b = await req.json<{ prompt_id?: string; session_id?: string; cwd?: string; prompt?: string; at?: number; prev?: { ai_text?: string } }>();
  const at = typeof b.at === "number" && b.at > 1.6e12 && b.at <= Date.now() ? b.at : Date.now(); // 백필은 원래 시각
  const split = splitPrompt(b.prompt ?? "");
  const denied = env.DENY_CWD.split(",").map((s) => s.trim()).filter(Boolean);
  if (!b.prompt_id || !b.session_id || !split || denied.some((d) => b.cwd?.startsWith(d))) return new Response(null, { status: 204 });
  const { ai_text, ...actions } = b.prev ?? {};
  await env.DB.prepare(
    "INSERT OR IGNORE INTO pairs (prompt_id, session_id, cwd, my_text, quoted, ai_text, ai_actions, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      b.prompt_id,
      b.session_id,
      b.cwd ?? null,
      redact(split.mine).slice(0, 20_000),
      split.quoted ? redact(split.quoted).slice(0, 20_000) : null,
      ai_text ? redact(ai_text).slice(-20_000) : null,
      redact(JSON.stringify(actions)),
      at,
    )
    .run();
  return new Response(null, { status: 204 });
}

// ── MCP OAuth: 동의 화면 → GitHub 로그인 → 내 계정만 통과 ─────────

async function authorize(req: Request, env: Env) {
  const oauth = env.OAUTH_PROVIDER;
  const request = await oauth.parseAuthRequest(req);
  if (await oauth.isConsentRemembered(req, request, { secret: env.COOKIE_SECRET })) return toGithub(req, env, request, new Headers());
  const details = await oauth.describeConsent(request);
  const consent = await oauth.beginConsent(request);
  consent.headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(consentPage(details, consent.handle), { headers: consent.headers });
}

async function approve(req: Request, env: Env) {
  const oauth = env.OAUTH_PROVIDER;
  const form = await req.formData();
  const handle = String(form.get("handle"));
  if (form.get("decision") !== "approve") return new Response(null, { status: 302, headers: (await oauth.denyConsent(req, handle)).headers });
  const approved = await oauth.approveConsent(req, handle, { remember: { secret: env.COOKIE_SECRET } });
  return toGithub(req, env, approved.request, approved.headers);
}

async function toGithub(req: Request, env: Env, request: AuthRequest, headers: Headers) {
  const upstream = await env.OAUTH_PROVIDER.beginUpstream(request, { headers });
  upstream.headers.set("Location", githubAuthorizeUrl(env, upstream.state, `${new URL(req.url).origin}/callback`));
  return new Response(null, { status: 302, headers: upstream.headers });
}

async function mcpCallback(req: Request, env: Env) {
  const url = new URL(req.url);
  const { request, headers } = await env.OAUTH_PROVIDER.finishUpstream(req);
  const code = url.searchParams.get("code");
  const user = code && !url.searchParams.get("error") ? await githubUser(env, code, `${url.origin}/callback`) : null;
  if (!user || String(user.id) !== env.ALLOWED_GITHUB_ID) {
    headers.set("Location", authorizationErrorRedirect(request, "access_denied"));
    return new Response(null, { status: 302, headers });
  }
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request,
    userId: String(user.id),
    metadata: { login: user.login },
    scope: request.scope,
    props: { userId: String(user.id) },
  });
  headers.set("Location", redirectTo);
  return new Response(null, { status: 302, headers });
}

const esc = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function consentPage(d: ConsentDescription, handle: string) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Insight 접근 허용</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem}button{font:inherit;padding:.5rem 1rem;margin-right:.5rem}</style>
<h1>${esc(d.clientName)}에 내 인사이트 접근을 허용할까요?</h1>
<p>${d.clientDomain ? `게시자: <strong>${esc(d.clientDomain)}</strong>` : "스스로 등록한 앱이라 이름은 검증되지 않았습니다."}</p>
<p>접근 권한이 전달될 곳: <strong>${esc(d.redirectHost)}</strong></p>
${d.redirectIsLoopback ? "<p><strong>내 컴퓨터의 앱으로 전달됩니다.</strong> 방금 직접 연결을 시작한 경우에만 허용하세요.</p>" : ""}
<form method="post"><input type="hidden" name="handle" value="${esc(handle)}">
<button name="decision" value="approve">허용</button><button name="decision" value="deny">거부</button></form>`;
}

// ── 대시보드 로그인: GitHub, 내 계정만 ─────────────────────────

function login(url: URL, env: Env) {
  const state = crypto.randomUUID();
  return redirect(githubAuthorizeUrl(env, state, `${url.origin}/callback`), {
    "Set-Cookie": `${STATE}=${state}; ${COOKIE}; Max-Age=600`,
  });
}

async function dashboardCallback(req: Request, env: Env) {
  const url = new URL(req.url);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (!state || !code || cookie(req, STATE) !== state) return new Response("로그인이 만료됐습니다. /login 부터 다시 해 주세요.", { status: 400 });
  const user = await githubUser(env, code, `${url.origin}/callback`);
  if (String(user.id) !== env.ALLOWED_GITHUB_ID) return new Response("forbidden", { status: 403 });
  const payload = `${user.id}.${Math.floor(Date.now() / 1000) + MONTH}`;
  const headers = new Headers({ Location: "/" });
  headers.append("Set-Cookie", `${SESSION}=${payload}.${await hmac(env, payload)}; ${COOKIE}; Max-Age=${MONTH}`);
  headers.append("Set-Cookie", `${STATE}=; ${COOKIE}; Max-Age=0`);
  return new Response(null, { status: 302, headers });
}

async function signedIn(req: Request, env: Env) {
  const [uid, exp, sig] = cookie(req, SESSION)?.split(".") ?? [];
  return uid === env.ALLOWED_GITHUB_ID && Number(exp) > Date.now() / 1000 && !!sig && safeEqual(sig, await hmac(env, `${uid}.${exp}`));
}

// ── 대시보드 API ─────────────────────────────────────────────

async function api(req: Request, env: Env, url: URL) {
  const q = url.searchParams;
  if (url.pathname === "/api/insights" && req.method === "GET") {
    const { results } = await env.DB.prepare(
      `SELECT i.*, t.statement AS theme FROM insights i LEFT JOIN themes t ON t.id = i.theme_id
       WHERE ((?1 IS NULL AND i.status != 'dismissed') OR i.status = ?1)
         AND (?2 IS NULL OR i.kind = ?2) AND (?3 IS NULL OR i.theme_id = ?3)
       ORDER BY i.at DESC LIMIT 300`,
    )
      .bind(q.get("status"), q.get("kind"), q.has("theme") ? Number(q.get("theme")) : null)
      .all();
    return Response.json(results);
  }
  if (url.pathname === "/api/themes") {
    const { results } = await env.DB.prepare(
      `SELECT t.id, t.statement, COUNT(i.id) AS count, COUNT(DISTINCT i.session_id) AS sessions, MAX(i.at) AS last_at
       FROM themes t JOIN insights i ON i.theme_id = t.id AND i.status != 'dismissed'
       GROUP BY t.id ORDER BY count DESC, last_at DESC`,
    ).all();
    return Response.json(results);
  }
  if (url.pathname === "/api/counts") {
    const counts = await env.DB.prepare(
      `SELECT SUM(status = 'candidate') AS candidate, SUM(status = 'confirmed') AS confirmed,
              SUM(kind = 'rejection' AND status != 'dismissed') AS rejection,
              (SELECT COUNT(*) FROM pairs WHERE done = 0) AS pending
       FROM insights`,
    ).first();
    return Response.json(counts);
  }
  const m = url.pathname.match(/^\/api\/insights\/(\d+)$/);
  if (m && req.method === "POST") {
    const { status } = await req.json<{ status: string }>();
    if (!["candidate", "confirmed", "dismissed"].includes(status)) return new Response("bad status", { status: 400 });
    await env.DB.prepare("UPDATE insights SET status = ? WHERE id = ?").bind(status, Number(m[1])).run();
    return new Response(null, { status: 204 });
  }
  return new Response("not found", { status: 404 });
}

// ── 읽기 전용 RPC: 같은 계정의 다른 Worker가 Service Binding으로 부른다 (HTTP로는 열리지 않는다) ──

export class ReadApi extends WorkerEntrypoint<Env> {
  /** 후보·확정 수, 아직 분석하지 않은 대화 수, 최근 확정 3개, 많이 나온 테마 3개 */
  async summary() {
    const db = this.env.DB;
    const [counts, recent, themes] = await Promise.all([
      db
        .prepare(
          `SELECT COALESCE(SUM(status = 'candidate'), 0) AS candidate, COALESCE(SUM(status = 'confirmed'), 0) AS confirmed,
                  (SELECT COUNT(*) FROM pairs WHERE done = 0) AS pending
           FROM insights`,
        )
        .first<{ candidate: number; confirmed: number; pending: number }>(),
      db.prepare("SELECT statement, kind, at FROM insights WHERE status = 'confirmed' ORDER BY at DESC LIMIT 3").all<{ statement: string; kind: string; at: number }>(),
      db
        .prepare(
          `SELECT t.statement, COUNT(i.id) AS count
           FROM themes t JOIN insights i ON i.theme_id = t.id AND i.status != 'dismissed'
           GROUP BY t.id ORDER BY count DESC, MAX(i.at) DESC LIMIT 3`,
        )
        .all<{ statement: string; count: number }>(),
    ]);
    return {
      candidate: counts?.candidate ?? 0,
      confirmed: counts?.confirmed ?? 0,
      pending: counts?.pending ?? 0,
      recent: recent.results,
      themes: themes.results,
    };
  }
}

// ── 공통 ─────────────────────────────────────────────────────

const redirect = (to: string, headers: Record<string, string> = {}) =>
  new Response(null, { status: 302, headers: { Location: to, ...headers } });

const cookie = (req: Request, name: string) =>
  req.headers
    .get("Cookie")
    ?.split(/;\s*/)
    .find((c) => c.startsWith(`${name}=`))
    ?.slice(name.length + 1);

function safeEqual(a: string, b: string) {
  const x = enc.encode(a);
  const y = enc.encode(b);
  return x.byteLength === y.byteLength && crypto.subtle.timingSafeEqual(x, y);
}

async function hmac(env: Env, data: string) {
  const key = await crypto.subtle.importKey("raw", enc.encode(env.COOKIE_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const githubAuthorizeUrl = (env: Env, state: string, redirectUri: string) =>
  `https://github.com/login/oauth/authorize?${new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID, redirect_uri: redirectUri, state, allow_signup: "false" })}`;

/** scope 없이 로그인만 한다: 공개 프로필의 id만 필요. */
async function githubUser(env: Env, code: string, redirectUri: string) {
  const token = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code, redirect_uri: redirectUri }),
  }).then((r) => r.json<{ access_token?: string; error?: string }>());
  if (!token.access_token) throw new Error(`github token: ${token.error}`);
  const res = await fetch("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${token.access_token}`, Accept: "application/vnd.github+json", "User-Agent": "ai-insight-agent" },
  });
  if (!res.ok) throw new Error(`github user: ${res.status}`);
  return res.json<{ id: number; login: string }>();
}

let provider: OAuthProvider<Env> | undefined;
const oauthProvider = (env: Env) => {
  if (provider) return provider;
  // 커스텀 도메인은 Host 검사 목록에 직접 넣어야 한다 (기본값은 workers.dev·localhost만)
  const mcp = createMcpHandler(mcpServer, { allowedHostnames: [new URL(env.PUBLIC_URL).hostname] });
  return (provider = new OAuthProvider<Env>({
    apiRoute: "/mcp",
    apiHandler: { fetch: (req, env, ctx) => mcp(req, env, ctx) },
    defaultHandler: { fetch: (req, env) => route(req, env) },
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    scopesSupported: ["insight"],
    resourceMetadata: { resource: `${env.PUBLIC_URL}/mcp`, authorization_servers: [env.PUBLIC_URL] },
  }));
};

export default {
  fetch: (req, env, ctx) => oauthProvider(env).fetch(req, env, ctx),
  scheduled: (_event, env, ctx) => ctx.waitUntil(extract(env)),
} satisfies ExportedHandler<Env>;
