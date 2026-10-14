-- 积分制商业化：钱包 / 流水 / 用量 / 订单。
--
-- 设计约定（与 socket-server/src/store*.ts 的实现配套）：
--   - 金额全部是整数：积分（1 积分 = $0.01 面值）、cost_micros（美元 × 1e6）
--   - credit_ledger 是账本的唯一事实来源，wallets.balance 是它的物化缓存；
--     每次变动同事务写 ledger + 更新 wallet
--   - 幂等：入账类操作（trial/purchase）靠 UNIQUE(user_id, reason, ref)，
--     同一个 ref 重放（webhook 重发、重试）不会二次入账
--   - 扣费允许小幅透支（turn 结束才知道成本），拦截在「发消息前」做

CREATE TABLE IF NOT EXISTS public.wallets (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  balance BIGINT NOT NULL DEFAULT 0,
  -- 试用积分只发一次（重置余额也不能再领）
  granted_trial BOOLEAN NOT NULL DEFAULT false,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS public.credit_ledger (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  delta BIGINT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('trial', 'purchase', 'usage', 'adjust')),
  -- 幂等键：trial 用 'signup'，purchase 用 waffo orderId，usage 用 usage_records.id
  ref TEXT,
  balance_after BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  UNIQUE (user_id, reason, ref)
);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON public.credit_ledger(user_id, created_at DESC);

-- 每个 agent 运行（turn）一行，pi agent_end 的 usage 聚合
CREATE TABLE IF NOT EXISTS public.usage_records (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  model TEXT,
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  cache_read_tokens BIGINT NOT NULL DEFAULT 0,
  cache_write_tokens BIGINT NOT NULL DEFAULT 0,
  cost_micros BIGINT NOT NULL,
  credits_charged BIGINT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_session ON public.usage_records(session_id);
CREATE INDEX IF NOT EXISTS idx_usage_user ON public.usage_records(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.orders (
  id TEXT PRIMARY KEY,                     -- 我们生成的 id，checkout metadata 回传
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  waffo_order_id TEXT,                     -- webhook 里的 waffo 侧 id
  product_id TEXT NOT NULL,
  pack TEXT NOT NULL,
  amount TEXT NOT NULL,                    -- waffo 的展示串约定，如 '5.00'
  credits BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed')),
  created_at BIGINT NOT NULL,
  completed_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON public.orders(user_id, created_at DESC);

-- RLS：用户只能读自己的行；写入全部走 service 连接（RLS 不生效），
-- 属主强制点在应用层。anon 没有任何数据面。
ALTER TABLE public.wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.usage_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own wallet select" ON public.wallets
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));
CREATE POLICY "own ledger select" ON public.credit_ledger
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));
CREATE POLICY "own usage select" ON public.usage_records
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));
CREATE POLICY "own orders select" ON public.orders
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));

GRANT SELECT ON public.wallets TO authenticated;
GRANT SELECT ON public.credit_ledger TO authenticated;
GRANT SELECT ON public.usage_records TO authenticated;
GRANT SELECT ON public.orders TO authenticated;
