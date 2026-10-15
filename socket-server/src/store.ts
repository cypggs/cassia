import type { AgentEvent, SessionSummary } from '@cassia/shared'
import type { CommercialStore } from './commercial/store.js'

/**
 * 事件与会话存储(CoreStore)。两个实现,env 驱动:
 *   - 设了 DATABASE_URL → PostgreSQL(生产,InsForge;store-pg.ts)
 *   - 否则 → SQLite 单文件(本地开发,零外部服务;store-sqlite.ts)
 *
 * 关键语义(两个实现必须一致):
 *
 * **客户端持游标,服务端无状态**。重连时客户端报出自己见过的最后一个
 * 事件 id,服务端只补差集。服务端不需要记住谁看到了哪。这样刷新页面
 * 不掉历史,服务端也不用为每个客户端记账。
 *
 * **upsert 收敛**。同 id 的事件就地替换(主键冲突 ON CONFLICT)——
 * assistant 流式消息和同一 actionId 的工具进展就靠这个收敛。
 *
 * **append 是同步外观**。事件管线不等写库;PG 实现内部用串行队列
 * 保序,SQLite 实现本来就同步。
 */
export interface CoreStore {
  /** 会话属主(null = 封存存量);会话不存在返回 undefined */
  sessionOwner(id: string): Promise<string | null | undefined>
  createSession(title?: string, userId?: string): Promise<SessionSummary>
  getSession(id: string): Promise<SessionSummary | undefined>
  /** userId 传了只列自己的;undefined(开放模式)列全部 */
  listSessions(userId?: string): Promise<SessionSummary[]>
  append(sessionId: string, event: AgentEvent): void
  /** 游标续传:返回 lastMessageId 之后的事件;游标未知则返回全部 */
  eventsSince(sessionId: string, lastMessageId?: string): Promise<AgentEvent[]>
  renameSession(id: string, title: string): Promise<void>
  /** 置顶/取消置顶。置顶用时间戳而不是布尔 —— 同一批置顶的也要有先后 */
  setPinned(id: string, pinned: boolean): Promise<void>
  /** 删会话;事件随外键级联删除 */
  deleteSession(id: string): Promise<void>
  close(): Promise<void>
}

/**
 * 完整存储 = 核心 + 商业化(积分/订单,见 commercial/store.ts)。
 * 实现类一次实现两半(共享一个 DB 连接);消费方各拿各的窄视图:
 * index.ts 只用 CoreStore,commercial/ 只用 CommercialStore。
 */
export interface Store extends CoreStore, CommercialStore {}

export async function createStore(): Promise<Store> {
  if (process.env.DATABASE_URL) {
    const { PgStore } = await import('./store-pg.js')
    console.log('store: PostgreSQL(DATABASE_URL 已配)')
    return new PgStore(process.env.DATABASE_URL)
  }
  const { SqliteStore } = await import('./store-sqlite.js')
  console.log('store: SQLite(未配 DATABASE_URL,本地开发模式)')
  return new SqliteStore()
}
