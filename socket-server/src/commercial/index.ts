import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Server, Socket } from 'socket.io'
import { verifyWebhook, WebhookEventType, type WebhookEventData } from '@waffo/pancake-ts'
import { nid } from '@cassia/shared'
import type { AgentEvent, UsageReportEvent } from '@cassia/shared'
import type { Store } from '../store.js'
import { authEnabled, verifyRequest, verifyToken, type AuthUser } from './auth.js'
import {
  CODE_BUDGET_CAP,
  CODE_INSUFFICIENT,
  creditsEnabled,
  priceUsage,
  SESSION_CREDIT_CAP,
  TRIAL_CREDITS,
} from './credits.js'
import { createCheckout, packs, waffoEnabled } from './waffo.js'

/**
 * 商业化可选模块 —— 鉴权、积分、支付。
 *
 * 设计原则：主链路（index.ts）里**没有任何商业化的 if**。
 * 开关在构造时一次决定：配了 INSFORGE_URL 就是 EnabledCommercial，
 * 否则是 NoopCommercial（所有方法都是直通/空实现）。
 *
 * 以后替换整个商业化方案（换 auth 供应商、换支付通道、换计费模型），
 * 只需要实现 Commercial 接口并换掉 createCommercial —— index.ts 不用动。
 * 这就是"没有什么东西是永恒的"在代码里的样子。
 */

export interface CommercialDeps {
  io: Server
  store: Store
  emit(sessionId: string, event: AgentEvent): void
  isAgentRunning(sessionId: string): boolean
  abortBridge(sessionId: string): void
}

export interface Commercial {
  readonly enabled: boolean
  /** 启动日志。Noop 版打印开放模式 */
  logStartup(): void
  /** io.use 鉴权中间件。Noop 版直接 next() */
  authMiddleware(socket: Socket, next: (err?: Error) => void): void
  /** 会话属主校验。开放模式恒 true */
  owns(userId: string | undefined, sessionId: string): Promise<boolean>
  /**
   * HTTP 端点的鉴权 + 属主校验。返回 undefined 表示已写好响应
   * （401 未登录 / 404 不属主）；null = 开放模式放行；AuthUser = 放行。
   */
  guardHttp(
    req: Parameters<typeof verifyRequest>[0],
    res: ServerResponse,
    sessionId: string,
  ): Promise<AuthUser | null | undefined>
  /** 发消息前的积分闸。开放模式恒 true */
  hasCredits(userId: string | undefined, sessionId: string): Promise<boolean>
  /**
   * usageReport 事件：按官价表定价（写回 event.costUsd/credits，
   * 广播+持久化的就是扣费那一刻的快照），再异步扣费不挡广播。
   * Noop 版什么都不做。
   */
  onUsageReport(sessionId: string, e: UsageReportEvent): void
  /** 注册钱包/收银台/e2e 后门的 socket handlers。Noop 版不注册 */
  registerSocketHandlers(socket: Socket, userId: string | undefined): void
  /** 商业化的 HTTP 路由（waffo webhook）。返回 true 表示已接管 */
  handleHttp(req: IncomingMessage, res: ServerResponse, url: URL): boolean
}

export function createCommercial(deps: CommercialDeps): Commercial {
  if (!authEnabled) return new NoopCommercial()
  return new EnabledCommercial(deps)
}

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** 开放模式：所有商业化能力静默关闭，行为与引入前完全一致 */
class NoopCommercial implements Commercial {
  readonly enabled = false
  logStartup(): void {
    console.log('auth: 开放模式（未配 INSFORGE_URL）')
  }
  authMiddleware(_socket: Socket, next: (err?: Error) => void): void {
    next()
  }
  async owns(): Promise<boolean> {
    return true
  }
  async guardHttp(): Promise<null> {
    return null
  }
  async hasCredits(): Promise<boolean> {
    return true
  }
  onUsageReport(): void {}
  registerSocketHandlers(socket: Socket): void {
    // 保持协议一致：开放模式 get_wallet 明确回 null（前端据此隐藏钱包 UI），
    // 而不是让 ack 永远不回。其他商业化 handler 一律不注册。
    socket.on('get_wallet', (_: unknown, ack?: (w: null) => void) => ack?.(null))
  }
  handleHttp(): boolean {
    return false
  }
}

class EnabledCommercial implements Commercial {
  readonly enabled = true
  constructor(private deps: CommercialDeps) {}

  logStartup(): void {
    console.log('auth: 强制登录（INSFORGE_URL 已配）')
    console.log(
      `credits: 启用（试用 ${TRIAL_CREDITS} / 会话上限 ${SESSION_CREDIT_CAP} / waffo ${waffoEnabled ? '已配' : '未配'}）`,
    )
  }

  authMiddleware(socket: Socket, next: (err?: Error) => void): void {
    void (async () => {
      const user = await verifyToken(String(socket.handshake.auth?.token ?? ''))
      if (!user) return next(new Error('unauthorized'))
      socket.data.userId = user.uid
      socket.data.email = user.email
      // 建档 + 试用积分（幂等，只发一次）。失败不挡登录 —— 积分治理是增强不是门槛
      if (creditsEnabled) {
        await this.deps.store
          .ensureWallet(user.uid, TRIAL_CREDITS)
          .catch((e) => console.warn('[credits] ensureWallet 失败:', e))
      }
      next()
    })()
  }

  async owns(userId: string | undefined, sessionId: string): Promise<boolean> {
    return !!userId && (await this.deps.store.sessionOwner(sessionId)) === userId
  }

  async guardHttp(
    req: Parameters<typeof verifyRequest>[0],
    res: ServerResponse,
    sessionId: string,
  ): Promise<AuthUser | null | undefined> {
    const user = await verifyRequest(req)
    if (!user) return json(res, 401, { error: '未登录' }), undefined
    if ((await this.deps.store.sessionOwner(sessionId)) !== user.uid)
      return json(res, 404, { error: '会话不存在' }), undefined
    return user
  }

  async hasCredits(userId: string | undefined, sessionId: string): Promise<boolean> {
    if (!creditsEnabled || !userId) return true
    if ((await this.deps.store.getBalance(userId)) > 0) return true
    this.deps.emit(sessionId, {
      id: nid(),
      type: 'statusUpdate',
      timestamp: Date.now(),
      agentStatus: this.deps.isAgentRunning(sessionId) ? 'running' : 'stopped',
      brief: '积分不足',
      description: '积分已用完，充值后可继续使用',
      code: CODE_INSUFFICIENT,
    })
    return false
  }

  onUsageReport(sessionId: string, e: UsageReportEvent): void {
    if (!creditsEnabled) return
    const priced = priceUsage(e, e.costUsd)
    e.costUsd = priced.costUsd
    e.credits = priced.credits
    void this.chargeForUsage(sessionId, e)
  }

  /**
   * 扣一轮用量。挂在 bridge 事件钩子上异步跑，不阻塞广播。
   * 扣完做两道后续：推 wallet_update（前端余额实时刷新）；
   * 查会话预算保险丝（到顶 abort 当前 turn）。
   */
  private async chargeForUsage(sessionId: string, e: UsageReportEvent): Promise<void> {
    const { store, io } = this.deps
    try {
      const owner = await store.sessionOwner(sessionId)
      if (!owner) return // 封存存量/开放模式没有属主，无从扣起
      const { costUsd, credits } = priceUsage(e, e.costUsd)
      const balance = await store.chargeUsage({
        sessionId,
        userId: owner,
        model: e.model,
        input: e.input,
        output: e.output,
        cacheRead: e.cacheRead,
        cacheWrite: e.cacheWrite,
        costUsd,
        credits,
      })
      io.to(`user:${owner}`).emit('wallet_update', { balance })

      const total = await store.sumSessionCredits(sessionId)
      if (total >= SESSION_CREDIT_CAP) {
        this.deps.abortBridge(sessionId)
        this.deps.emit(sessionId, {
          id: nid(),
          type: 'statusUpdate',
          timestamp: Date.now(),
          agentStatus: 'failed',
          brief: '会话预算已达上限',
          description: `本会话累计消耗 ${total} 积分，已达 ${SESSION_CREDIT_CAP} 上限，已自动停止。新建会话可继续`,
          code: CODE_BUDGET_CAP,
        })
      }
    } catch (err) {
      // 扣费失败不该炸事件流 —— 但这一轮就白送了，必须喊出来对账
      console.error(`[${sessionId}] usage 扣费失败:`, err)
    }
  }

  registerSocketHandlers(socket: Socket, userId: string | undefined): void {
    const { store, io } = this.deps

    /** 钱包快照：余额 + 最近流水 + 可购档位（未启用积分返回 null） */
    socket.on('get_wallet', async (_: unknown, ack?: (w: unknown) => void) => {
      if (!creditsEnabled || !userId) return ack?.(null)
      ack?.({
        balance: await store.getBalance(userId),
        ledger: await store.recentLedger(userId, 20),
        packs: packs.map((p) => ({ key: p.key, amount: p.amount, credits: p.credits })),
        waffo: waffoEnabled,
      })
    })

    /**
     * 开收银台：先落本地 pending 订单（id 进 metadata 当幂等纽带），
     * 再向 waffo 要托管页 URL。waffo 失败就把单子废掉，不留僵尸 pending。
     */
    socket.on('create_checkout', async (p: { pack: string }, ack?: (r: { checkoutUrl: string } | null) => void) => {
      if (!creditsEnabled || !userId || !waffoEnabled) return ack?.(null)
      const pack = packs.find((k) => k.key === p?.pack)
      if (!pack) return ack?.(null)
      const order = {
        id: nid(),
        userId,
        productId: pack.productId,
        pack: pack.key,
        amount: pack.amount,
        credits: pack.credits,
        status: 'pending' as const,
        createdAt: Date.now(),
      }
      try {
        const checkoutUrl = await createCheckout(order, socket.data.email as string | undefined)
        await store.createOrder(order)
        ack?.({ checkoutUrl })
      } catch (e) {
        console.error('[waffo] createCheckout 失败:', e)
        ack?.(null)
      }
    })

    // e2e 后门：直接入账（负值 = 扣减，测耗尽路径用）。生产 env 绝不设
    // CREDITS_DEBUG —— 注册了才是漏洞
    if (process.env.CREDITS_DEBUG === '1') {
      socket.on('debug_grant', async (p: { credits: number }, ack?: (r: { balance: number } | null) => void) => {
        if (!creditsEnabled || !userId) return ack?.(null)
        const credits = Math.max(-100_000, Math.min(100_000, Math.floor(p?.credits ?? 0)))
        const balance = await store.grantCredits(userId, credits, `debug:${nid()}`)
        io.to(`user:${userId}`).emit('wallet_update', { balance })
        ack?.({ balance })
      })
    }
  }

  handleHttp(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
    // waffo 支付回执。验签要原始字节 —— 必须赶在任何 body 解析之前拿走
    if (url.pathname === '/webhooks/waffo' && req.method === 'POST') {
      void this.waffoWebhook(req, res)
      return true
    }
    return false
  }

  /**
   * waffo 支付回执：验签（SDK 内置 test/prod 公钥，event.mode 区分环境）→
   * 先 200 再异步入账。入账幂等性不在这一层 —— completeOrder 的
   * 「pending 才翻转」+ ledger UNIQUE(ref) 已经兜住 webhook 重放。
   */
  private async waffoWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const body = Buffer.concat(chunks).toString('utf8')

    let event
    try {
      event = verifyWebhook<WebhookEventData>(body, req.headers['x-waffo-signature'] as string | undefined)
    } catch (e) {
      console.warn('[waffo] webhook 验签失败:', e instanceof Error ? e.message : e)
      return json(res, 401, { error: 'invalid signature' })
    }
    // waffo 重试策略不容慢响应 —— 先确认收到，处理放后台
    json(res, 200, { ok: true })

    if (event.eventType !== WebhookEventType.OrderCompleted) return
    const orderId = event.data?.orderMetadata?.orderId ?? event.data?.orderMerchantExternalId
    if (!orderId) {
      console.warn('[waffo] order.completed 缺 metadata.orderId，无法入账', event.eventId)
      return
    }
    try {
      const done = await this.deps.store.completeOrder(orderId, event.data.orderId)
      if (!done) return // 重放或未知单
      console.log(`[waffo] 入账 order=${orderId} mode=${event.mode} credits 已到账`)
      this.deps.io.to(`user:${done.userId}`).emit('wallet_update', { balance: done.balance })
    } catch (e) {
      console.error(`[waffo] 入账失败 order=${orderId}:`, e)
    }
  }
}
