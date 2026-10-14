import pg from 'pg'
import { nid } from '@cassia/shared'
import type { AgentEvent, SessionSummary } from '@cassia/shared'
import type { CreditOrder, LedgerEntry, Store, UsageCharge } from './store.js'

/**
 * 生产存储：InsForge PostgreSQL（表结构见 migrations/20260804085907_cassia-core.sql）。
 *
 * 与 SQLite 实现的语义对齐点：
 *   - **append 保持同步外观**。调用方（事件管线）不等它 —— 写入进内存队列
 *     串行执行，次序 = 到达次序（游标语义依赖这个）。失败只记日志：
 *     事件已经广播给在线客户端了，写库失败不该炸掉实时链路。
 *   - **eventsSince 游标**：SQLite 用 (ts, rowid)，这里用 (ts, seq)
 *     （seq 是 identity 列）。游标不存在同样退化成全量。
 *   - user_id 是 uuid 列（references auth.users），开放模式写 NULL。
 *
 * 连接是 service 级（postgres 角色，RLS 不生效）—— 属主隔离的强制点
 * 仍在应用层（owns / guardHttp），RLS 只管 PostgREST 直连。
 */

export class PgStore implements Store {
  private pool: pg.Pool
  /** 写入串行队列：保序 + 背压内聚在一处 */
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(connectionString: string) {
    this.pool = new pg.Pool({
      connectionString,
      max: 4,
      keepAlive: true,
      // sslmode=require 已在连接串里；pg 默认 require 不验证书，InsForge 的
      // 证书链公网 CA 签的，开了验证也行 —— 但 pool 重连场景下少一个故障面
      ssl: { rejectUnauthorized: false },
    })
  }

  async sessionOwner(id: string): Promise<string | null | undefined> {
    const { rows } = await this.pool.query('SELECT user_id FROM sessions WHERE id = $1', [id])
    if (!rows.length) return undefined
    return rows[0].user_id
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
    await this.pool.query(
      'INSERT INTO sessions (id, title, created_at, updated_at, agent_status, user_id) VALUES ($1, $2, $3, $4, $5, $6)',
      [summary.id, title, now, now, 'stopped', userId ?? null],
    )
    return summary
  }

  async getSession(id: string): Promise<SessionSummary | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM sessions WHERE id = $1', [id])
    return rows.length ? toSummary(rows[0]) : undefined
  }

  /** userId 传了就只列自己的；undefined（开放模式）列全部，与 SQLite 版一致。
   *  排序：置顶优先，其余按最近活跃。 */
  async listSessions(userId?: string): Promise<SessionSummary[]> {
    const order = 'ORDER BY (pinned_at IS NULL), updated_at DESC'
    const { rows } = userId
      ? await this.pool.query(`SELECT * FROM sessions WHERE user_id = $1 ${order}`, [userId])
      : await this.pool.query(`SELECT * FROM sessions ${order}`)
    return rows.map(toSummary)
  }

  append(sessionId: string, event: AgentEvent): void {
    this.writeQueue = this.writeQueue
      .then(() => this.doAppend(sessionId, event))
      .catch((e) => console.error(`[store] append 失败（session=${sessionId} event=${event.id}）:`, e))
  }

  private async doAppend(sessionId: string, event: AgentEvent): Promise<void> {
    const updates: string[] = ['updated_at = $2']
    const params: unknown[] = [sessionId, event.timestamp]
    let n = 2

    if (event.type === 'statusUpdate') {
      updates.push(`agent_status = $${++n}`)
      params.push(event.agentStatus)
    }
    if (event.type === 'sandboxUpdate') {
      updates.push(`sandbox_id = $${++n}`)
      params.push(event.sandboxId)
    }
    // 首条用户消息当标题
    if (event.type === 'chat' && event.sender === 'user') {
      updates.push(`title = CASE WHEN title = '新任务' THEN $${++n} ELSE title END`)
      params.push(event.content.slice(0, 40))
    }
    await this.pool.query(`UPDATE sessions SET ${updates.join(', ')} WHERE id = $1`, params)

    if (event.noPersistent) return

    // 同 id 就地更新（流式消息、工具进展）
    await this.pool.query(
      'INSERT INTO events (id, session_id, ts, payload) VALUES ($1, $2, $3, $4) ' +
        'ON CONFLICT(id) DO UPDATE SET ts = excluded.ts, payload = excluded.payload',
      [event.id, sessionId, event.timestamp, JSON.stringify(event)],
    )
  }

  /** 游标续传：返回 lastMessageId 之后的事件；游标未知则返回全部 */
  async eventsSince(sessionId: string, lastMessageId?: string): Promise<AgentEvent[]> {
    if (!lastMessageId) {
      const { rows } = await this.pool.query(
        'SELECT payload FROM events WHERE session_id = $1 ORDER BY ts, seq',
        [sessionId],
      )
      return rows.map((r) => r.payload as AgentEvent)
    }
    // (ts, seq) 双键定位游标，避免同毫秒事件错位；游标不存在退化成全量
    const { rows } = await this.pool.query(
      `SELECT payload FROM events WHERE session_id = $1 AND (ts, seq) > (
         SELECT ts, seq FROM events WHERE id = $2 AND session_id = $1
       ) ORDER BY ts, seq`,
      [sessionId, lastMessageId],
    )
    if (rows.length === 0) {
      const total = await this.pool.query(
        'SELECT COUNT(*)::int AS n FROM events WHERE session_id = $1',
        [sessionId],
      )
      if (total.rows[0].n > 0) return this.eventsSince(sessionId)
    }
    return rows.map((r) => r.payload as AgentEvent)
  }

  async close(): Promise<void> {
    await this.pool.end()
  }

  async renameSession(id: string, title: string): Promise<void> {
    await this.pool.query('UPDATE sessions SET title = $2 WHERE id = $1', [id, title])
  }

  async setPinned(id: string, pinned: boolean): Promise<void> {
    await this.pool.query('UPDATE sessions SET pinned_at = $2 WHERE id = $1', [
      id,
      pinned ? Date.now() : null,
    ])
  }

  /** events 外键是 ON DELETE CASCADE，删会话一行就够 */
  async deleteSession(id: string): Promise<void> {
    await this.pool.query('DELETE FROM sessions WHERE id = $1', [id])
  }

  // ── 积分（幂等约定见 store.ts；多步写入全走事务） ──

  /** 多步写共用的事务壳：拿独占 client，COMMIT/ROLLBACK，用完归还 */
  private async tx<T>(fn: (q: (sql: string, params?: unknown[]) => Promise<pg.QueryResult>) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const out = await fn((sql, params) => client.query(sql, params as never[]))
      await client.query('COMMIT')
      return out
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
  }

  async ensureWallet(userId: string, trialCredits: number): Promise<number> {
    const now = Date.now()
    return this.tx(async (q) => {
      await q(
        'INSERT INTO wallets (user_id, balance, granted_trial, updated_at) VALUES ($1, 0, false, $2) ON CONFLICT (user_id) DO NOTHING',
        [userId, now],
      )
      if (trialCredits > 0) {
        const r = await q(
          'UPDATE wallets SET granted_trial = true, balance = balance + $2, updated_at = $3 WHERE user_id = $1 AND granted_trial = false RETURNING balance',
          [userId, trialCredits, now],
        )
        if (r.rows.length) {
          await q(
            'INSERT INTO credit_ledger (id, user_id, delta, reason, ref, balance_after, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING',
            [nid(), userId, trialCredits, 'trial', 'signup', num(r.rows[0].balance), now],
          )
        }
      }
      const b = await q('SELECT balance FROM wallets WHERE user_id = $1', [userId])
      return num(b.rows[0].balance)
    })
  }

  async getBalance(userId: string): Promise<number> {
    const { rows } = await this.pool.query('SELECT balance FROM wallets WHERE user_id = $1', [userId])
    return rows.length ? num(rows[0].balance) : 0
  }

  async chargeUsage(rec: UsageCharge): Promise<number> {
    const now = Date.now()
    const id = nid()
    return this.tx(async (q) => {
      await q(
        'INSERT INTO wallets (user_id, balance, granted_trial, updated_at) VALUES ($1, 0, false, $2) ON CONFLICT (user_id) DO NOTHING',
        [rec.userId, now],
      )
      await q(
        `INSERT INTO usage_records (id, user_id, session_id, model, input_tokens, output_tokens,
           cache_read_tokens, cache_write_tokens, cost_micros, credits_charged, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [id, rec.userId, rec.sessionId, rec.model ?? null, rec.input, rec.output,
          rec.cacheRead, rec.cacheWrite, Math.round(rec.costUsd * 1e6), rec.credits, now],
      )
      const r = await q(
        'UPDATE wallets SET balance = balance - $2, updated_at = $3 WHERE user_id = $1 RETURNING balance',
        [rec.userId, rec.credits, now],
      )
      const balance = num(r.rows[0].balance)
      await q(
        'INSERT INTO credit_ledger (id, user_id, delta, reason, ref, balance_after, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [nid(), rec.userId, -rec.credits, 'usage', id, balance, now],
      )
      return balance
    })
  }

  async sumSessionCredits(sessionId: string): Promise<number> {
    const { rows } = await this.pool.query(
      'SELECT COALESCE(SUM(credits_charged), 0) AS total FROM usage_records WHERE session_id = $1',
      [sessionId],
    )
    return num(rows[0].total)
  }

  async recentLedger(userId: string, limit = 20): Promise<LedgerEntry[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM credit_ledger WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2',
      [userId, limit],
    )
    return rows.map((r) => ({
      id: r.id,
      delta: num(r.delta),
      reason: r.reason,
      ref: r.ref,
      balanceAfter: num(r.balance_after),
      createdAt: num(r.created_at),
    }))
  }

  async createOrder(o: CreditOrder): Promise<void> {
    await this.pool.query(
      'INSERT INTO orders (id, user_id, product_id, pack, amount, credits, status, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [o.id, o.userId, o.productId, o.pack, o.amount, o.credits, 'pending', o.createdAt],
    )
  }

  async completeOrder(orderId: string, waffoOrderId: string): Promise<{ userId: string; balance: number } | false> {
    const now = Date.now()
    return this.tx(async (q) => {
      const o = await q(
        "UPDATE orders SET status = 'completed', waffo_order_id = $2, completed_at = $3 WHERE id = $1 AND status = 'pending' RETURNING user_id, credits",
        [orderId, waffoOrderId, now],
      )
      if (!o.rows.length) return false // 重放或未知单 —— 幂等返回
      const { user_id: userId, credits } = o.rows[0]
      await q(
        'INSERT INTO wallets (user_id, balance, granted_trial, updated_at) VALUES ($1, 0, false, $2) ON CONFLICT (user_id) DO NOTHING',
        [userId, now],
      )
      const w = await q(
        'UPDATE wallets SET balance = balance + $2, updated_at = $3 WHERE user_id = $1 RETURNING balance',
        [userId, num(credits), now],
      )
      await q(
        'INSERT INTO credit_ledger (id, user_id, delta, reason, ref, balance_after, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING',
        [nid(), userId, num(credits), 'purchase', orderId, num(w.rows[0].balance), now],
      )
      return { userId, balance: num(w.rows[0].balance) }
    })
  }

  async failOrder(orderId: string): Promise<void> {
    await this.pool.query("UPDATE orders SET status = 'failed' WHERE id = $1 AND status = 'pending'", [orderId])
  }

  async grantCredits(userId: string, credits: number, ref: string): Promise<number> {
    const now = Date.now()
    return this.tx(async (q) => {
      await q(
        'INSERT INTO wallets (user_id, balance, granted_trial, updated_at) VALUES ($1, 0, false, $2) ON CONFLICT (user_id) DO NOTHING',
        [userId, now],
      )
      const w = await q(
        'UPDATE wallets SET balance = balance + $2, updated_at = $3 WHERE user_id = $1 RETURNING balance',
        [userId, credits, now],
      )
      const balance = num(w.rows[0].balance)
      await q(
        'INSERT INTO credit_ledger (id, user_id, delta, reason, ref, balance_after, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING',
        [nid(), userId, credits, 'adjust', ref, balance, now],
      )
      return balance
    })
  }
}

/** pg 把 bigint 返回成字符串 —— 统一在这转 number */
function num(v: unknown): number {
  return Number(v)
}

interface SessionRow {
  id: string
  title: string
  created_at: string | number
  updated_at: string | number
  agent_status: SessionSummary['agentStatus']
  sandbox_id: string | null
  pinned_at: string | number | null
}

function toSummary(r: SessionRow): SessionSummary {
  return {
    id: r.id,
    title: r.title,
    // pg 把 bigint 返回成字符串（超过 JS 安全整数的可能性）—— 转回 number
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    agentStatus: r.agent_status,
    sandboxId: r.sandbox_id ?? undefined,
    pinnedAt: r.pinned_at == null ? undefined : Number(r.pinned_at),
  }
}
