import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { nid } from '@cassia/shared'
import type { AgentEvent, SessionSummary } from '@cassia/shared'
import type { Store } from './store.js'
import type { CreditOrder, LedgerEntry, UsageCharge } from './commercial/store.js'

// node 每次加载 node:sqlite 都会打一条 ExperimentalWarning。
// 它是我们刻意选的依赖（零外部包、随 node 走），不是意外 —— 压在源头，
// 比让每条 stderr 都多一行噪音强。
const _emit = process.emitWarning
process.emitWarning = function (this: unknown, warning: string | Error, ...rest: unknown[]) {
  const text = typeof warning === 'string' ? warning : warning?.message ?? ''
  if (text.includes('SQLite is an experimental feature')) return
  return (_emit as (...a: unknown[]) => void).call(this, warning, ...rest)
} as typeof process.emitWarning

// 动态 import 而不是顶部静态 import：警告是在模块**加载**时打的，
// 静态 import 在文件求值前就触发，上面那层拦截就来不及了。
import type { DatabaseSync as DatabaseSyncT } from 'node:sqlite'
const { DatabaseSync } = (await import('node:sqlite')) as {
  DatabaseSync: new (path: string) => DatabaseSyncT
}

/**
 * 本地开发用的存储：SQLite，一个文件，零外部服务。
 * 生产用 PostgreSQL（store-pg.ts），两个实现语义必须一致 ——
 * 接口和关键语义（游标、upsert）的说明见 store.ts。
 *
 * 方法签名是 async 的，但 SQLite 是同步驱动 —— 只是为了和 PG 实现同型。
 */

export class SqliteStore implements Store {
  private db: DatabaseSyncT

  constructor(dbPath = process.env.DB_PATH ?? '.workspace/cassia.db') {
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new DatabaseSync(dbPath)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        agent_status TEXT NOT NULL,
        sandbox_id TEXT,
        user_id TEXT
      );
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        ts INTEGER NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, ts);
      -- 积分（成本治理）。列与 PG 版一一对应，幂等约定见 store.ts
      CREATE TABLE IF NOT EXISTS wallets (
        user_id TEXT PRIMARY KEY,
        balance INTEGER NOT NULL DEFAULT 0,
        granted_trial INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS credit_ledger (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        delta INTEGER NOT NULL,
        reason TEXT NOT NULL,
        ref TEXT,
        balance_after INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (user_id, reason, ref)
      );
      CREATE INDEX IF NOT EXISTS idx_ledger_user ON credit_ledger(user_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS usage_records (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        model TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        cost_micros INTEGER NOT NULL,
        credits_charged INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_usage_session ON usage_records(session_id);
      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        waffo_order_id TEXT,
        product_id TEXT NOT NULL,
        pack TEXT NOT NULL,
        amount TEXT NOT NULL,
        credits INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        completed_at INTEGER
      );
    `)
    // 老库平滑迁移：sessions 没有 user_id 列就补上。
    // 存量行 user_id = NULL —— 鉴权模式下对所有人不可见（封存），
    // 开放模式（userId 恒为 null）照旧全部可见，行为与迁移前一致。
    const cols = this.db.prepare('PRAGMA table_info(sessions)').all() as unknown as { name: string }[]
    if (!cols.some((c) => c.name === 'user_id')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN user_id TEXT')
    }
    // 同上：pinned_at（置顶时间，NULL = 未置顶）
    if (!cols.some((c) => c.name === 'pinned_at')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN pinned_at INTEGER')
    }
  }

  /** 会话属主（NULL = 鉴权引入前的存量，封存不可见）；会话不存在返回 undefined */
  async sessionOwner(id: string): Promise<string | null | undefined> {
    const row = this.db.prepare('SELECT user_id FROM sessions WHERE id = ?').get(id) as unknown as
      | { user_id: string | null }
      | undefined
    return row?.user_id
  }

  async createSession(title = '新任务', userId?: string): Promise<SessionSummary> {
    const now = Date.now()
    const summary: SessionSummary = {
      id: nid(),
      title,
      createdAt: now,
      updatedAt: now,
      agentStatus: 'stopped',
    }
    this.db.prepare(
      'INSERT INTO sessions (id, title, created_at, updated_at, agent_status, user_id) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(summary.id, title, now, now, 'stopped', userId ?? null)
    return summary
  }

  async getSession(id: string): Promise<SessionSummary | undefined> {
    const row = this.db
      .prepare('SELECT * FROM sessions WHERE id = ?')
      .get(id) as unknown as SessionRow | undefined
    return row ? toSummary(row) : undefined
  }

  /**
   * 列会话。鉴权模式传 userId 只列自己的；开放模式（userId 恒 undefined）列全部，
   * 行为与鉴权引入前一致。封存的存量会话（user_id IS NULL）只在开放模式可见。
   * 排序：置顶优先（ pinned_at 非 NULL），其余按最近活跃。
   */
  async listSessions(userId?: string): Promise<SessionSummary[]> {
    const order = 'ORDER BY (pinned_at IS NULL), updated_at DESC'
    const rows = (
      userId
        ? this.db.prepare(`SELECT * FROM sessions WHERE user_id = ? ${order}`).all(userId)
        : this.db.prepare(`SELECT * FROM sessions ${order}`).all()
    ) as unknown as SessionRow[]
    return rows.map(toSummary)
  }

  /** 同步外观：SQLite 本就同步，直接写。语义（同 id upsert、游标）见 store.ts */
  append(sessionId: string, event: AgentEvent): void {
    const updates: string[] = ['updated_at = ?']
    const params: unknown[] = [event.timestamp]

    if (event.type === 'statusUpdate') {
      updates.push('agent_status = ?')
      params.push(event.agentStatus)
    }
    if (event.type === 'sandboxUpdate') {
      updates.push('sandbox_id = ?')
      params.push(event.sandboxId)
    }
    // 首条用户消息当标题 —— 够用，且不必等 LLM 生成
    if (event.type === 'chat' && event.sender === 'user') {
      updates.push("title = CASE WHEN title = '新任务' THEN ? ELSE title END")
      params.push(event.content.slice(0, 40))
    }
    params.push(sessionId)
    this.db
      .prepare(`UPDATE sessions SET ${updates.join(', ')} WHERE id = ?`)
      .run(...(params as never[]))

    if (event.noPersistent) return

    // 同 id 就地更新（流式消息、工具进展）—— 主键冲突 REPLACE
    this.db
      .prepare(
        'INSERT INTO events (id, session_id, ts, payload) VALUES (?, ?, ?, ?) ' +
          'ON CONFLICT(id) DO UPDATE SET ts = excluded.ts, payload = excluded.payload',
      )
      .run(event.id, sessionId, event.timestamp, JSON.stringify(event))
  }

  /** 游标续传：返回 lastMessageId 之后的事件；游标未知则返回全部 */
  async eventsSince(sessionId: string, lastMessageId?: string): Promise<AgentEvent[]> {
    let rows: EventRow[]
    if (!lastMessageId) {
      rows = this.db
        .prepare('SELECT payload FROM events WHERE session_id = ? ORDER BY ts, rowid')
        .all(sessionId) as unknown as EventRow[]
    } else {
      // 用子查询找到游标的位置（ts + rowid 双键，避免同毫秒事件错位），
      // 只返回它之后的。游标不存在（比如换了个库）就退化成返回全部。
      rows = this.db
        .prepare(
          `SELECT payload FROM events WHERE session_id = ? AND (ts, rowid) > (
             SELECT ts, rowid FROM events WHERE id = ? AND session_id = ?
           ) ORDER BY ts, rowid`,
        )
        .all(sessionId, lastMessageId, sessionId) as unknown as EventRow[]
      // 子查询没命中时上面返回空 —— 这时候要回退成「全量」，不能让用户以为历史丢了
      if (rows.length === 0) {
        const total = this.db
          .prepare('SELECT COUNT(*) AS n FROM events WHERE session_id = ?')
          .get(sessionId) as unknown as { n: number }
        if (total.n > 0) return this.eventsSince(sessionId)
      }
    }
    return rows.map((r) => JSON.parse(r.payload) as AgentEvent)
  }

  async close(): Promise<void> {
    this.db.close()
  }

  async renameSession(id: string, title: string): Promise<void> {
    this.db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(title, id)
  }

  async setPinned(id: string, pinned: boolean): Promise<void> {
    this.db.prepare('UPDATE sessions SET pinned_at = ? WHERE id = ?').run(pinned ? Date.now() : null, id)
  }

  async deleteSession(id: string): Promise<void> {
    // events 有 ON DELETE CASCADE，但 node:sqlite 默认不开外键 —— 手动开不起
    // （得在连接级 PRAGMA），这里直接两句删，顺序就是级联顺序
    this.db.prepare('DELETE FROM events WHERE session_id = ?').run(id)
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
  }

  // ── 积分（幂等约定见 store.ts；SQLite 单进程同步，BEGIN 即原子） ──

  private ensureWalletRow(userId: string, now: number): void {
    this.db
      .prepare('INSERT INTO wallets (user_id, balance, granted_trial, updated_at) VALUES (?, 0, 0, ?) ON CONFLICT (user_id) DO NOTHING')
      .run(userId, now)
  }

  async ensureWallet(userId: string, trialCredits: number): Promise<number> {
    const now = Date.now()
    this.ensureWalletRow(userId, now)
    if (trialCredits > 0) {
      const r = this.db
        .prepare('UPDATE wallets SET granted_trial = 1, balance = balance + ?, updated_at = ? WHERE user_id = ? AND granted_trial = 0 RETURNING balance')
        .get(trialCredits, now, userId) as unknown as { balance: number } | undefined
      if (r) {
        this.db
          .prepare('INSERT INTO credit_ledger (id, user_id, delta, reason, ref, balance_after, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING')
          .run(nid(), userId, trialCredits, 'trial', 'signup', r.balance, now)
      }
    }
    return this.getBalance(userId)
  }

  async getBalance(userId: string): Promise<number> {
    const r = this.db.prepare('SELECT balance FROM wallets WHERE user_id = ?').get(userId) as unknown as
      | { balance: number }
      | undefined
    return r?.balance ?? 0
  }

  async chargeUsage(rec: UsageCharge): Promise<number> {
    const now = Date.now()
    const id = nid()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.ensureWalletRow(rec.userId, now)
      this.db
        .prepare(
          `INSERT INTO usage_records (id, user_id, session_id, model, input_tokens, output_tokens,
             cache_read_tokens, cache_write_tokens, cost_micros, credits_charged, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, rec.userId, rec.sessionId, rec.model ?? null, rec.input, rec.output,
          rec.cacheRead, rec.cacheWrite, Math.round(rec.costUsd * 1e6), rec.credits, now)
      const r = this.db
        .prepare('UPDATE wallets SET balance = balance - ?, updated_at = ? WHERE user_id = ? RETURNING balance')
        .get(rec.credits, now, rec.userId) as unknown as { balance: number }
      this.db
        .prepare('INSERT INTO credit_ledger (id, user_id, delta, reason, ref, balance_after, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(nid(), rec.userId, -rec.credits, 'usage', id, r.balance, now)
      this.db.exec('COMMIT')
      return r.balance
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  async sumSessionCredits(sessionId: string): Promise<number> {
    const r = this.db
      .prepare('SELECT COALESCE(SUM(credits_charged), 0) AS total FROM usage_records WHERE session_id = ?')
      .get(sessionId) as unknown as { total: number }
    return r.total
  }

  async recentLedger(userId: string, limit = 20): Promise<LedgerEntry[]> {
    const rows = this.db
      .prepare('SELECT * FROM credit_ledger WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(userId, limit) as unknown as {
      id: string; delta: number; reason: LedgerEntry['reason']; ref: string | null
      balance_after: number; created_at: number
    }[]
    return rows.map((r) => ({
      id: r.id,
      delta: r.delta,
      reason: r.reason,
      ref: r.ref,
      balanceAfter: r.balance_after,
      createdAt: r.created_at,
    }))
  }

  async createOrder(o: CreditOrder): Promise<void> {
    this.db
      .prepare('INSERT INTO orders (id, user_id, product_id, pack, amount, credits, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(o.id, o.userId, o.productId, o.pack, o.amount, o.credits, 'pending', o.createdAt)
  }

  async completeOrder(orderId: string, waffoOrderId: string): Promise<{ userId: string; balance: number } | false> {
    const now = Date.now()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const o = this.db
        .prepare("UPDATE orders SET status = 'completed', waffo_order_id = ?, completed_at = ? WHERE id = ? AND status = 'pending' RETURNING user_id, credits")
        .get(waffoOrderId, now, orderId) as unknown as { user_id: string; credits: number } | undefined
      if (!o) {
        this.db.exec('ROLLBACK') // 重放或未知单 —— 幂等返回
        return false
      }
      this.ensureWalletRow(o.user_id, now)
      const w = this.db
        .prepare('UPDATE wallets SET balance = balance + ?, updated_at = ? WHERE user_id = ? RETURNING balance')
        .get(o.credits, now, o.user_id) as unknown as { balance: number }
      this.db
        .prepare('INSERT INTO credit_ledger (id, user_id, delta, reason, ref, balance_after, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING')
        .run(nid(), o.user_id, o.credits, 'purchase', orderId, w.balance, now)
      this.db.exec('COMMIT')
      return { userId: o.user_id, balance: w.balance }
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  async failOrder(orderId: string): Promise<void> {
    this.db.prepare("UPDATE orders SET status = 'failed' WHERE id = ? AND status = 'pending'").run(orderId)
  }

  async grantCredits(userId: string, credits: number, ref: string): Promise<number> {
    const now = Date.now()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.ensureWalletRow(userId, now)
      const w = this.db
        .prepare('UPDATE wallets SET balance = balance + ?, updated_at = ? WHERE user_id = ? RETURNING balance')
        .get(credits, now, userId) as unknown as { balance: number }
      this.db
        .prepare('INSERT INTO credit_ledger (id, user_id, delta, reason, ref, balance_after, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING')
        .run(nid(), userId, credits, 'adjust', ref, w.balance, now)
      this.db.exec('COMMIT')
      return w.balance
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }
}

interface SessionRow {
  id: string
  title: string
  created_at: number
  updated_at: number
  agent_status: SessionSummary['agentStatus']
  sandbox_id: string | null
  user_id: string | null
  pinned_at: number | null
}

interface EventRow {
  payload: string
}

function toSummary(r: SessionRow): SessionSummary {
  return {
    id: r.id,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    agentStatus: r.agent_status,
    sandboxId: r.sandbox_id ?? undefined,
    pinnedAt: r.pinned_at ?? undefined,
  }
}
