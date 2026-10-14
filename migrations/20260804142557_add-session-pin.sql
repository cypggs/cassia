-- 会话置顶：pinned_at（置顶时间，NULL = 未置顶）。
-- 列表排序由应用层做（ORDER BY (pinned_at IS NULL), updated_at DESC），
-- 置顶优先、其余按最近活跃。RLS 策略不变 —— 属主策略照旧覆盖新列。

ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS pinned_at BIGINT;
