-- 직전 AI 행동 → 내 말, 한 쌍이 분석 단위 (Claude Code 훅)
CREATE TABLE pairs (
  prompt_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  cwd TEXT,
  my_text TEXT NOT NULL,
  quoted TEXT,
  ai_text TEXT,
  ai_actions TEXT,
  at INTEGER NOT NULL,
  done INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX pairs_pending ON pairs (done, session_id);

-- 반복되는 '평소 가치관'
CREATE TABLE themes (
  id INTEGER PRIMARY KEY,
  statement TEXT NOT NULL UNIQUE,
  at INTEGER NOT NULL
);

-- 내 생각과 거절. code = 훅에서 추출(후보), mcp = 대화 중 내가 OK(확정)
CREATE TABLE insights (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('code', 'mcp')),
  prompt_id TEXT,
  session_id TEXT,
  project TEXT,
  kind TEXT NOT NULL,
  reaction TEXT NOT NULL,
  statement TEXT NOT NULL,
  seed TEXT NOT NULL DEFAULT '',
  expression TEXT,
  ai_proposal TEXT,
  reason TEXT,
  context TEXT,
  theme_id INTEGER REFERENCES themes (id),
  confidence REAL,
  status TEXT NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate', 'confirmed', 'dismissed')),
  at INTEGER NOT NULL
);
CREATE INDEX insights_status ON insights (status, at);
