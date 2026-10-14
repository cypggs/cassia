-- Cassia 核心表：会话 + 事件流。
-- 语义对齐 SQLite 版（socket-server/src/store-sqlite.ts）：
--   - 时间戳是毫秒 epoch（bigint），与应用层一致
--   - events.seq（identity）替代 SQLite 的 rowid 做同毫秒事件的次序裁决
--   - events.payload 是整个 AgentEvent 的 JSON（jsonb），upsert 靠主键冲突
-- 访问模型：socket-server 用 service 连接直连（RLS 不生效，属主校验在应用层）；
-- RLS 是给 PostgREST 直连（前端/未来功能）的防线：用户只能碰自己的行。

CREATE TABLE IF NOT EXISTS public.sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  agent_status TEXT NOT NULL,
  sandbox_id TEXT,
  -- 属主 = InsForge 用户；NULL = 鉴权引入前的存量（封存，RLS 下无人可见）
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  ts BIGINT NOT NULL,
  payload JSONB NOT NULL,
  seq BIGINT GENERATED ALWAYS AS IDENTITY
);

CREATE INDEX IF NOT EXISTS idx_events_session ON public.events(session_id, ts, seq);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON public.sessions(user_id, updated_at DESC);

ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;

-- sessions：属主全权
CREATE POLICY "own sessions select" ON public.sessions
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));
CREATE POLICY "own sessions insert" ON public.sessions
  FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY "own sessions update" ON public.sessions
  FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY "own sessions delete" ON public.sessions
  FOR DELETE TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- events：跟随会话属主（跨表 EXISTS，不自引用所以无递归问题）
CREATE POLICY "own events select" ON public.events
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.sessions s
    WHERE s.id = events.session_id AND s.user_id = (SELECT auth.uid())
  ));
CREATE POLICY "own events insert" ON public.events
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.sessions s
    WHERE s.id = events.session_id AND s.user_id = (SELECT auth.uid())
  ));
CREATE POLICY "own events update" ON public.events
  FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.sessions s
    WHERE s.id = events.session_id AND s.user_id = (SELECT auth.uid())
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.sessions s
    WHERE s.id = events.session_id AND s.user_id = (SELECT auth.uid())
  ));
CREATE POLICY "own events delete" ON public.events
  FOR DELETE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.sessions s
    WHERE s.id = events.session_id AND s.user_id = (SELECT auth.uid())
  ));

-- 权限与策略配套：RLS 不替代 GRANT。anon 一律不给 —— 未登录没有任何数据面。
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sessions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.events TO authenticated;
