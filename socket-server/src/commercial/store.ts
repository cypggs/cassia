// ── 商业化存储:钱包 / 流水 / 订单 ────────────────────────────────────
//
// 这是 CommercialStore —— Store 的商业化一半(会话/事件那半在
// ../store.ts 的 CoreStore)。拆开的理由:主链路不该知道积分表的存在,
// 换掉整个商业化方案时这个文件跟着 commercial/ 一起走。
//
// 物理上两个实现(SQLite/PG)仍是一个类、一个库 —— 共享连接池,
// 拆成两个类各连一次库是为解耦付的真成本,不值。边界画在类型上:
// commercial/ 只看得见 CommercialStore,index.ts 只看得见 CoreStore。

export interface WalletInfo {
  balance: number
  grantedTrial: boolean
}

export interface UsageCharge {
  sessionId: string
  userId: string
  model?: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** 美元(pi 价目表),落库时换算成 micros */
  costUsd: number
  /** 已按倍率换算好的积分(换算规则在 credits.ts,store 只管记账) */
  credits: number
}

export interface LedgerEntry {
  id: string
  delta: number
  reason: 'trial' | 'purchase' | 'usage' | 'adjust'
  ref: string | null
  balanceAfter: number
  createdAt: number
}

export interface CreditOrder {
  id: string
  userId: string
  waffoOrderId?: string
  productId: string
  pack: string
  amount: string
  credits: number
  status: 'pending' | 'completed' | 'failed'
  createdAt: number
}

/**
 * 积分写入的幂等约定(两个实现都必须遵守):
 * - 入账类(trial / purchase / adjust)以 (user_id, reason, ref) 唯一,
 *   同一个 ref 重放不二次入账
 * - 每次余额变动必须同事务写 credit_ledger + 更新 wallets,
 *   ledger 是事实来源,balance 是物化缓存
 * - 扣费允许透支到负数(turn 结束才知道成本),拦截在发消息前做
 */
export interface CommercialStore {
  /** 建档(幂等);首次会发 trialCredits 试用积分(也只发这一次)。返回当前余额 */
  ensureWallet(userId: string, trialCredits: number): Promise<number>
  getBalance(userId: string): Promise<number>
  /** 扣一轮用量(usage_records + ledger + wallet 原子落账)。返回扣后余额 */
  chargeUsage(rec: UsageCharge): Promise<number>
  /** 某会话累计已扣积分(会话预算用) */
  sumSessionCredits(sessionId: string): Promise<number>
  recentLedger(userId: string, limit?: number): Promise<LedgerEntry[]>
  createOrder(o: CreditOrder): Promise<void>
  /** webhook 入账。已处理过(非 pending)返回 false —— webhook 重放安全;
   *  成功返回属主与最新余额(推送 wallet_update 用) */
  completeOrder(orderId: string, waffoOrderId: string): Promise<{ userId: string; balance: number } | false>
  failOrder(orderId: string): Promise<void>
  /** 直接入账(运营调整 / e2e 后门)。ref 必须调用方给足唯一性 */
  grantCredits(userId: string, credits: number, ref: string): Promise<number>
}
