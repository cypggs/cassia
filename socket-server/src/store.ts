import type { AgentEvent, SessionSummary } from '@cassia/shared'

// ── 积分（成本治理） ──────────────────────────────────────────────────

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
  /** 美元（pi 价目表），落库时换算成 micros */
  costUsd: number
  /** 已按倍率换算好的积分（换算规则在 credits.ts，store 只管记账） */
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
 * 积分写入的幂等约定（两个实现都必须遵守）：
 * - 入账类（trial / purchase / adjust）以 (user_id, reason, ref) 唯一，
 *   同一个 ref 重放不二次入账
 * - 每次余额变动必须同事务写 credit_ledger + 更新 wallets，
 *   ledger 是事实来源，balance 是物化缓存
 * - 扣费允许透支到负数（turn 结束才知道成本），拦截在发消息前做
 */

/**
 * 事件存储。两个实现，env 驱动：
 *   - 设了 DATABASE_URL → PostgreSQL（生产，InsForge；store-pg.ts）
 *   - 否则 → SQLite 单文件（本地开发，零外部服务；store-sqlite.ts）
 *
 * 关键语义（两个实现必须一致）：
 *
 * **客户端持游标，服务端无状态**。重连时客户端报出自己见过的最后一个
 * 事件 id，服务端只补差集。服务端不需要记住谁看到了哪。这样刷新页面
 * 不掉历史，服务端也不用为每个客户端记账。
 *
 * **upsert 收敛**。同 id 的事件就地替换（主键冲突 ON CONFLICT）——
 * assistant 流式消息和同一 actionId 的工具进展就靠这个收敛。
 *
 * **append 是同步外观**。事件管线不等写库；PG 实现内部用串行队列
 * 保序，SQLite 实现本来就同步。
 */

export interface Store {
  /** 会话属主（null = 封存存量）；会话不存在返回 undefined */
  sessionOwner(id: string): Promise<string | null | undefined>
  createSession(title?: string, userId?: string): Promise<SessionSummary>
  getSession(id: string): Promise<SessionSummary | undefined>
  /** userId 传了只列自己的；undefined（开放模式）列全部 */
  listSessions(userId?: string): Promise<SessionSummary[]>
  append(sessionId: string, event: AgentEvent): void
  /** 游标续传：返回 lastMessageId 之后的事件；游标未知则返回全部 */
  eventsSince(sessionId: string, lastMessageId?: string): Promise<AgentEvent[]>
  renameSession(id: string, title: string): Promise<void>
  /** 置顶/取消置顶。置顶用时间戳而不是布尔 —— 同一批置顶的也要有先后 */
  setPinned(id: string, pinned: boolean): Promise<void>
  /** 删会话；事件随外键级联删除 */
  deleteSession(id: string): Promise<void>

  // ── 积分（幂等约定见上方类型块） ──
  /** 建档（幂等）；首次会发 trialCredits 试用积分（也只发这一次）。返回当前余额 */
  ensureWallet(userId: string, trialCredits: number): Promise<number>
  getBalance(userId: string): Promise<number>
  /** 扣一轮用量（usage_records + ledger + wallet 原子落账）。返回扣后余额 */
  chargeUsage(rec: UsageCharge): Promise<number>
  /** 某会话累计已扣积分（会话预算用） */
  sumSessionCredits(sessionId: string): Promise<number>
  recentLedger(userId: string, limit?: number): Promise<LedgerEntry[]>
  createOrder(o: CreditOrder): Promise<void>
  /** webhook 入账。已处理过（非 pending）返回 false —— webhook 重放安全；
   *  成功返回属主与最新余额（推送 wallet_update 用） */
  completeOrder(orderId: string, waffoOrderId: string): Promise<{ userId: string; balance: number } | false>
  failOrder(orderId: string): Promise<void>
  /** 直接入账（运营调整 / e2e 后门）。ref 必须调用方给足唯一性 */
  grantCredits(userId: string, credits: number, ref: string): Promise<number>
  close(): Promise<void>
}

export async function createStore(): Promise<Store> {
  if (process.env.DATABASE_URL) {
    const { PgStore } = await import('./store-pg.js')
    console.log('store: PostgreSQL（DATABASE_URL 已配）')
    return new PgStore(process.env.DATABASE_URL)
  }
  const { SqliteStore } = await import('./store-sqlite.js')
  console.log('store: SQLite（未配 DATABASE_URL，本地开发模式）')
  return new SqliteStore()
}
