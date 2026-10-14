import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { Server } from 'socket.io'
import { nid } from '@cassia/shared'
import type {
  AgentEvent,
  ChatEvent,
  JoinSessionAck,
  JoinSessionPayload,
  SessionSummary,
  UsageReportEvent,
} from '@cassia/shared'
import { verifyWebhook, WebhookEventType, type WebhookEventData } from '@waffo/pancake-ts'
import { RuntimeBridge } from './bridge.js'
import { provision, reconnect, type RuntimeHandle } from './sandbox.js'
import { createStore } from './store.js'
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
import { compactHistory } from './compact.js'

/**
 * 控制面。三件事：会话 CRUD、事件流广播、沙箱生命周期。
 *
 * 视频流**不经过这里** —— 前端拿到 sandboxUpdate 里的 vncUrl 后直连沙箱。
 * 控制面只搬事件（KB 级），不搬画面（MB/s 级）—— 成本和延迟都省。
 */

const PORT = Number(process.env.SOCKET_PORT ?? 4000)
const MODEL = process.env.PI_MODEL ?? 'deepseek/deepseek-flash'
/** 空闲多久回收沙箱。沙箱是按时间计费的，忘了关就是一直在烧。 */
const IDLE_MS = Number(process.env.SANDBOX_IDLE_MS ?? 15 * 60 * 1000)
/**
 * 运行中但零事件的硬上限。agentRunning 期间心跳会一直续期（防任务中途
 * 被 E2B 收走），但如果 settled 事件丢了 / pi 僵死，这个「运行中」就是
 * 谎话，沙箱费空烧到地老天荒。命令有 30min 兜底超时，正常任务事件不断，
 * 3 小时零事件只能是状态死了 —— 强制收尾，诚实告知。
 */
const STUCK_RUN_MS = Number(process.env.STUCK_RUN_MS ?? 3 * 60 * 60 * 1000)

const store = await createStore()

interface Live {
  handle: RuntimeHandle
  bridge: RuntimeBridge | null
  /** 最后一次有人跟这个会话交互的时间，用于空闲休眠 */
  lastActive: number
  /**
   * Agent 是否正在执行任务。跑着的会话绝不能当空闲回收 ——
   * 一条 `sleep 600` 可以十几分钟不产生任何事件，lastActive 会撒谎。
   */
  agentRunning: boolean
  /**
   * 休眠 = bridge 已断开、沙箱交给 E2B 的 onTimeout 去暂停。
   * 沙箱本体还在（全内存快照），下次活跃时 resume 原地醒来。
   */
  dormant: boolean
}
const live = new Map<string, Live>()
/** 同一会话的并发 provision 去重 —— 用户连点两下不该起两个沙箱 */
const provisioning = new Map<string, Promise<Live>>()
/** sessionId → 等 agent_start 的回调（死窗补投用，见 deliverMessage） */
const startWaiters = new Map<string, Set<() => void>>()
/** sessionId → 等「被判休眠」的回调（同上：沙箱死了要尽快补投，不能干等） */
const dormantWaiters = new Map<string, Set<() => void>>()

/** 上传上限。不切片不续传，超了就是超了 —— 100MB 对任务材料绰绰有余 */
const MAX_UPLOAD = Number(process.env.MAX_UPLOAD_MB ?? 100) * 1024 * 1024

const http = createServer((req, res) => {
  // 前端 :3000 直连 :4000，文件端点和 socket.io 同样需要 CORS
  res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN ?? '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization')
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end()
    return
  }
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (url.pathname === '/healthz') {
    void store.listSessions().then((list) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, sessions: list.length }))
    })
    return
  }
  // waffo 支付回执。验签要原始字节 —— 必须赶在任何 body 解析之前拿走
  if (url.pathname === '/webhooks/waffo' && req.method === 'POST') {
    return void waffoWebhook(req, res)
  }
  // 附件通道。路径形态：/sessions/:sid/files（POST 上传 / GET 列表）、
  // /sessions/:sid/file?path=（GET 下载）
  const files = url.pathname.match(/^\/sessions\/([^/]+)\/files$/)
  if (files && req.method === 'POST') return void uploadFile(files[1], url, req, res)
  if (files && req.method === 'GET') return void listSessionFiles(files[1], req, res)
  const file = url.pathname.match(/^\/sessions\/([^/]+)\/file$/)
  if (file && req.method === 'GET') return void downloadFile(file[1], url, req, res)
  res.writeHead(404).end()
})

const json = (res: ServerResponse, code: number, body: unknown): void => {
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** 会话有没有过沙箱 —— 没有的话列表/下载不该为它 provision 一台新机器 */
async function everHadSandbox(sessionId: string): Promise<boolean> {
  return live.has(sessionId) || !!(await store.getSession(sessionId))?.sandboxId
}

/** 文件名消毒：只留「最后一个路径段」，去掉首字符的点，空了就拒 */
function sanitizeName(raw: string): string | null {
  const base = raw.split(/[\\/]/).pop()?.replace(/^\.+/, '').trim()
  return base && base.length <= 255 ? base : null
}

/** 路径穿越防护：会话目录内的相对路径，任何 . / .. 段都拒 */
function safeRel(raw: string): string | null {
  const parts = raw.split('/').filter(Boolean)
  if (!parts.length || parts.some((p) => p === '.' || p === '..')) return null
  return parts.join('/')
}

async function uploadFile(
  sessionId: string,
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if ((await guardHttp(req, res, sessionId)) === undefined) return
  if (!(await store.getSession(sessionId))) return json(res, 404, { error: '会话不存在' })
  const name = sanitizeName(url.searchParams.get('name') ?? '')
  if (!name) return json(res, 400, { error: '文件名缺失或不合法' })

  // 上传 = 用户要干活的明确信号：没沙箱 provision、休眠的唤醒
  let l: Live
  try {
    l = await ensureRuntime(sessionId)
  } catch (e) {
    return json(res, 502, { error: `计算环境不可用：${e instanceof Error ? e.message : e}` })
  }

  // 边收边数边转给沙箱，超限即断 —— 不在控制面堆整个文件
  let size = 0
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, ctrl) {
      size += chunk.byteLength
      if (size > MAX_UPLOAD) ctrl.error(new Error(`文件超过 ${MAX_UPLOAD / 1024 / 1024}MB 上限`))
      else ctrl.enqueue(chunk)
    },
  })
  try {
    await l.handle.writeFile(
      `uploads/${name}`,
      Readable.toWeb(req).pipeThrough(counter) as ReadableStream<Uint8Array>,
    )
  } catch (e) {
    req.destroy()
    const msg = e instanceof Error ? e.message : String(e)
    return json(res, size > MAX_UPLOAD ? 413 : 502, { error: msg })
  }
  json(res, 200, { name, path: `uploads/${name}`, size })
}

async function listSessionFiles(
  sessionId: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if ((await guardHttp(req, res, sessionId)) === undefined) return
  if (!(await store.getSession(sessionId))) return json(res, 404, { error: '会话不存在' })
  if (!(await everHadSandbox(sessionId))) return json(res, 200, { files: [] })
  try {
    const l = await ensureRuntime(sessionId)
    json(res, 200, { files: await l.handle.listFiles() })
  } catch (e) {
    json(res, 502, { error: e instanceof Error ? e.message : String(e) })
  }
}

/** 下载用的 mime 小表，没命中就 octet-stream 让浏览器存盘 */
const MIME: Record<string, string> = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', mp4: 'video/mp4',
  zip: 'application/zip', gz: 'application/gzip', csv: 'text/csv',
  json: 'application/json', txt: 'text/plain', md: 'text/markdown', html: 'text/html',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

async function downloadFile(
  sessionId: string,
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if ((await guardHttp(req, res, sessionId)) === undefined) return
  if (!(await store.getSession(sessionId))) return json(res, 404, { error: '会话不存在' })
  const rel = safeRel(url.searchParams.get('path') ?? '')
  if (!rel) return json(res, 400, { error: '路径不合法' })
  if (!(await everHadSandbox(sessionId))) return json(res, 404, { error: '文件不存在' })

  try {
    const l = await ensureRuntime(sessionId)
    const stream = await l.handle.readFile(rel)
    const name = rel.split('/').pop()!
    const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
    res.writeHead(200, {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    })
    Readable.fromWeb(stream as Parameters<typeof Readable.fromWeb>[0]).pipe(res)
  } catch (e) {
    if (!res.headersSent) json(res, 404, { error: `读不到文件：${e instanceof Error ? e.message : e}` })
    else res.destroy()
  }
}

const io = new Server(http, {
  cors: { origin: process.env.CORS_ORIGIN ?? '*' },
  // 历史会话的 join ack 是 MB 级 JSON，websocket 帧压缩能再砍 ~5-10x
  // （浏览器原生协商，客户端零改动）；>1KB 的消息才压，小消息不值 CPU
  perMessageDeflate: { threshold: 1024 },
})

/**
 * 鉴权中间件。开放模式（没配 INSFORGE_URL）直接放行，userId 恒 undefined，
 * 行为和鉴权引入前一致；鉴权模式验 socket 令牌。用户档案由 InsForge 管
 * （auth.users），这里不再另建 users 表。
 */
io.use(async (socket, next) => {
  if (!authEnabled) return next()
  const user = await verifyToken(String(socket.handshake.auth?.token ?? ''))
  if (!user) return next(new Error('unauthorized'))
  socket.data.userId = user.uid
  socket.data.email = user.email
  // 建档 + 试用积分（幂等，只发一次）。失败不挡登录 —— 积分治理是增强不是门槛
  if (creditsEnabled) {
    await store.ensureWallet(user.uid, TRIAL_CREDITS).catch((e) => console.warn('[credits] ensureWallet 失败:', e))
  }
  next()
})

/**
 * 属主校验。开放模式恒 true；鉴权模式会话的 user_id 必须等于当前用户。
 * 存量会话（user_id NULL）谁都不属于 —— 封存不可见。
 */
async function owns(userId: string | undefined, sessionId: string): Promise<boolean> {
  if (!authEnabled) return true
  return !!userId && (await store.sessionOwner(sessionId)) === userId
}

/**
 * HTTP 端点的鉴权 + 属主校验。返回 undefined 表示放行；
 * 否则已写好响应（401 未登录 / 404 不属主 —— 不属主按不存在处理，防枚举）。
 */
async function guardHttp(
  req: Parameters<typeof verifyRequest>[0],
  res: ServerResponse,
  sessionId: string,
): Promise<AuthUser | null | undefined> {
  if (!authEnabled) return null
  const user = await verifyRequest(req)
  if (!user) return json(res, 401, { error: '未登录' }), undefined
  if ((await store.sessionOwner(sessionId)) !== user.uid) return json(res, 404, { error: '会话不存在' }), undefined
  return user
}

function emit(sessionId: string, event: AgentEvent): void {
  store.append(sessionId, event)
  io.to(sessionId).emit('event', { sessionId, event })
}

/**
 * waffo 支付回执：验签（SDK 内置 test/prod 公钥，event.mode 区分环境）→
 * 先 200 再异步入账。入账幂等性不在这一层 —— completeOrder 的
 * 「pending 才翻转」+ ledger UNIQUE(ref) 已经兜住 webhook 重放。
 */
async function waffoWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
    const done = await store.completeOrder(orderId, event.data.orderId)
    if (!done) return // 重放或未知单
    console.log(`[waffo] 入账 order=${orderId} mode=${event.mode} credits 已到账`)
    io.to(`user:${done.userId}`).emit('wallet_update', { balance: done.balance })
  } catch (e) {
    console.error(`[waffo] 入账失败 order=${orderId}:`, e)
  }
}

/**
 * 发消息前的积分闸。开放模式/未启用直接放行；余额 ≤0 发「积分不足」
 * 状态事件（code 是前端开充值弹框的信号，不渲染文案匹配）。
 * agentStatus 如实反映当前运行态 —— steer 被拦时 agent 还在跑，不能说 stopped。
 */
async function hasCredits(userId: string | undefined, sessionId: string): Promise<boolean> {
  if (!creditsEnabled || !userId) return true
  if ((await store.getBalance(userId)) > 0) return true
  const l = live.get(sessionId)
  emit(sessionId, {
    id: nid(),
    type: 'statusUpdate',
    timestamp: Date.now(),
    agentStatus: l?.agentRunning ? 'running' : 'stopped',
    brief: '积分不足',
    description: '积分已用完，充值后可继续使用',
    code: CODE_INSUFFICIENT,
  })
  return false
}

/**
 * 扣一轮用量。挂在 bridge 事件钩子上异步跑，不阻塞广播。
 * 扣完做两道后续：推 wallet_update（前端余额实时刷新）；
 * 查会话预算保险丝（到顶 abort 当前 turn）。
 */
async function chargeForUsage(sessionId: string, e: UsageReportEvent): Promise<void> {
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
      live.get(sessionId)?.bridge?.abort()
      emit(sessionId, {
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

function systemEvent(text: string): AgentEvent {
  return {
    id: nid(),
    type: 'liveStatus',
    timestamp: Date.now(),
    text,
    noPersistent: true,
  }
}

function openBridge(sessionId: string, handle: RuntimeHandle): RuntimeBridge {
  const bridge = new RuntimeBridge(handle.wsUrl, sessionId, {
    model: MODEL,
    env: pickApiKeys(),
  })
  bridge.on('event', (e: AgentEvent) => {
    // Agent 自己在干活也算活跃 —— 否则长任务跑到一半会被休眠掉
    touch(sessionId)
    if (e.type === 'statusUpdate') {
      const l = live.get(sessionId)
      if (l) l.agentRunning = e.agentStatus === 'running'
      // agent_start 是「prompt 真的送到了」的唯一证据 —— 唤醒等它的补投逻辑
      if (e.agentStatus === 'running') {
        startWaiters.get(sessionId)?.forEach((fn) => fn())
        startWaiters.delete(sessionId)
      }
    }
    // 成本计量：turn 结束的真实 usage。按官价表定价（pi 内置价目是涨价前
    // 旧价，只作表外模型兜底），把换算好的积分和计费口径的美元成本写进事件
    // （广播+持久化的就是扣费那一刻的快照），再异步扣费不挡广播
    if (e.type === 'usageReport' && creditsEnabled) {
      const priced = priceUsage(e, e.costUsd)
      e.costUsd = priced.costUsd
      e.credits = priced.credits
      void chargeForUsage(sessionId, e)
    }
    emit(sessionId, e)
  })
  bridge.on('warn', (m: string) => console.warn(`[${sessionId}] ${m}`))
  // 沙箱被外部暂停/回收后 bridge 会 502 空转 —— 收到不可达信号就诚实标记
  // 休眠，下条消息走 ensureRuntime 的 resume 分支原地唤醒
  bridge.on('unreachable', () => {
    const l = live.get(sessionId)
    if (l && l.bridge === bridge) markDormant(sessionId, l)
  })
  bridge.connect()
  return bridge
}

async function ensureRuntime(sessionId: string): Promise<Live> {
  const existing = live.get(sessionId)
  if (existing && !existing.dormant) return existing
  const inflight = provisioning.get(sessionId)
  if (inflight) return inflight

  const task = (async () => {
    // ── 唤醒休眠的沙箱：文件、进程、对话上下文都还在
    if (existing?.dormant) {
      emit(sessionId, systemEvent('正在唤醒计算环境…'))
      try {
        await existing.handle.resume()
        existing.bridge = openBridge(sessionId, existing.handle)
        existing.dormant = false
        existing.lastActive = Date.now()
        emit(sessionId, {
          id: nid(),
          type: 'sandboxUpdate',
          timestamp: Date.now(),
          sandboxId: existing.handle.sandboxId,
          status: 'running',
          vncUrl: existing.handle.vncUrl,
          webRTCUrl: existing.handle.webRTCUrl,
        })
        return existing
      } catch (e) {
        // 快照有保留期，睡太久的沙箱会被彻底清掉 —— 退回「起一台新的」
        console.warn(`[${sessionId}] 唤醒失败，改为新建沙箱:`, e instanceof Error ? e.message : e)
        await existing.handle.kill().catch(() => {})
        live.delete(sessionId)
        emit(sessionId, systemEvent('原计算环境已过期回收，正在准备新环境…'))
      }
    }

    // ── 服务重启后的透明接回：live 是内存表，重启即空，但 DB 记着每个
    // 会话用过的沙箱。先试着接回去（connect 会自动唤醒 paused 的沙箱），
    // 接不上（快照过期被回收）再退回新建 —— 用户看到的是同一台电脑。
    if (!existing) {
      const remembered = (await store.getSession(sessionId))?.sandboxId
      if (remembered) {
        try {
          const handle = await reconnect(remembered, sessionId)
          emit(sessionId, {
            id: nid(),
            type: 'sandboxUpdate',
            timestamp: Date.now(),
            sandboxId: handle.sandboxId,
            status: 'running',
          })
          const bridge = openBridge(sessionId, handle)
          const l: Live = { handle, bridge, lastActive: Date.now(), agentRunning: false, dormant: false }
          live.set(sessionId, l)
          return l
        } catch (e) {
          console.warn(`[${sessionId}] 接回沙箱 ${remembered} 失败，改为新建:`, e instanceof Error ? e.message : e)
          // DB 里过期的 sandbox_id 不用清 —— 新建后的 sandboxUpdate 会覆盖它
        }
      }
    }

    emit(sessionId, systemEvent('正在准备计算环境…'))

    const handle = await provision({ model: MODEL, sessionId })

    emit(sessionId, {
      id: nid(),
      type: 'sandboxUpdate',
      timestamp: Date.now(),
      sandboxId: handle.sandboxId,
      status: 'running',
      vncUrl: handle.vncUrl,
      webRTCUrl: handle.webRTCUrl,
    })

    const bridge = openBridge(sessionId, handle)

    const l: Live = { handle, bridge, lastActive: Date.now(), agentRunning: false, dormant: false }
    live.set(sessionId, l)
    return l
  })()

  provisioning.set(sessionId, task)
  try {
    return await task
  } finally {
    provisioning.delete(sessionId)
  }
}

/**
 * 只把 pi 需要的 provider key 透进沙箱，不整包倒环境变量。
 * 这些 key 随 attach 下发给 runtime，不出现在镜像里，也不进 E2B 的 envs。
 */
function pickApiKeys(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of [
    'DEEPSEEK_API_KEY',
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'MOONSHOT_API_KEY',
    'OPENROUTER_API_KEY',
    'ZAI_API_KEY',
    'PI_API_KEY',
  ]) {
    const v = process.env[k]
    if (v) out[k] = v
  }
  return out
}

function touch(sessionId: string): void {
  const l = live.get(sessionId)
  if (!l) return
  l.lastActive = Date.now()
  // 同时把 E2B 的硬超时往后推 —— 它从创建起算、不随活跃刷新，
  // 不续的话长任务到点会被拦腰斩断
  l.handle.touch()
}

/**
 * 空闲休眠。
 *
 * 不杀沙箱：断开 bridge（不然 bridge 的重连循环产生的流量会干扰休眠语义），
 * 之后 E2B 的 onTimeout 倒计时自然到点，把沙箱做全内存快照挂起 —— 不计费，
 * 文件、进程、pi 的对话上下文全保留。下次活跃走 ensureRuntime 的 resume 分支。
 *
 * Agent 还在跑的时候不算空闲：每次事件流有动静都会 touch。
 */
/**
 * 把会话标记为休眠：断开 bridge，发 paused 事件。
 * 两个触发点：reapIdle（正常闲置）和 bridge 的 unreachable（沙箱被外部
 * 暂停/回收，比如 E2B 自己的 onTimeout —— 那之后 bridge 只会 502 空转，
 * 与其假活不如诚实标记休眠，下条消息走 resume 原地唤醒）。
 */
function markDormant(sessionId: string, l: Live): void {
  if (l.dormant) return
  l.dormant = true
  l.bridge?.close()
  l.bridge = null
  console.log(`[${sessionId}] 休眠 sandbox=${l.handle.sandboxId}`)
  // 唤醒可能在等的补投逻辑 —— 沙箱死了要尽快重投，不能干等 agent_start
  dormantWaiters.get(sessionId)?.forEach((fn) => fn())
  dormantWaiters.delete(sessionId)
  emit(sessionId, {
    id: nid(),
    type: 'sandboxUpdate',
    timestamp: Date.now(),
    sandboxId: l.handle.sandboxId,
    status: 'paused',
  })
}

async function reapIdle(): Promise<void> {
  const now = Date.now()
  for (const [sessionId, l] of live) {
    if (l.dormant) continue
    // 成本安全带：「运行中」但长期零事件 = 状态在撒谎（settled 丢了 /
    // pi 僵死）。心跳续期会沿着这个谎话一直烧钱 —— 强制收尾。
    if (l.agentRunning && now - l.lastActive >= STUCK_RUN_MS) {
      console.warn(`[${sessionId}] 运行中但 ${Math.round((now - l.lastActive) / 3600_0) / 100}h 零事件，强制收尾`)
      l.agentRunning = false
      l.bridge?.abort() // 万一 turn 还活着，给它一个停下的机会
      emit(sessionId, {
        id: nid(),
        type: 'statusUpdate',
        timestamp: now,
        agentStatus: 'failed',
        brief: '任务长时间无进展，已自动停止',
        description: `超过 ${Math.round(STUCK_RUN_MS / 3600_0) / 100} 小时没有任何事件，为控制成本已暂停计算环境；发消息可唤醒继续`,
      })
      markDormant(sessionId, l)
      continue
    }
    if (l.agentRunning || now - l.lastActive < IDLE_MS) continue
    markDormant(sessionId, l)
  }
}
// 检查间隔取空闲窗口的三分之一，封在 [5s, 60s] 内 —— 固定 60s 的话，
// 把窗口调短（测试、或按秒计费的部署）就永远来不及回收。
const REAP_MS = Math.max(5_000, Math.min(60_000, Math.floor(IDLE_MS / 3)))
const reaper = setInterval(() => void reapIdle(), REAP_MS)
reaper.unref()

/**
 * 运行中会话的续期心跳。
 *
 * E2B 的 timeoutMs 不随活跃刷新，平时靠事件流里的 touch 续 —— 但一条
 * 长时间没有输出的命令（比如等网络的 publish）可以整场没有一个事件，
 * E2B 到点就把沙箱暂停了，控制面还以为它在跑（线上事故：agent 卡住、
 * 消息进黑洞、停止无效）。agentRunning 期间每分钟续一次，别让 E2B
 * 在任务中途收走机器。makeTouch 内部有 60s 防抖，这里只管触发。
 */
const heartbeat = setInterval(() => {
  for (const l of live.values()) {
    if (!l.dormant && l.agentRunning) l.handle.touch()
  }
}, 60_000)
heartbeat.unref()

io.on('connection', (socket) => {
  /** 鉴权模式 = 当前用户；开放模式 = undefined（listSessions 列全部、owns 恒 true） */
  const userId = socket.data.userId as string | undefined
  // 用户级房间：wallet_update 这类不属任何会话的推送往这里发
  if (userId) void socket.join(`user:${userId}`)

  socket.on('list_sessions', async (_: unknown, ack?: (s: SessionSummary[]) => void) => {
    ack?.(await store.listSessions(userId))
  })

  socket.on('create_session', async (_: unknown, ack?: (s: SessionSummary) => void) => {
    ack?.(await store.createSession('新任务', userId))
  })

  socket.on('rename_session', async (p: { sessionId: string; title: string }, ack?: (ok: boolean) => void) => {
    const title = String(p.title ?? '').trim().slice(0, 60)
    if (!title || !(await owns(userId, p.sessionId))) return ack?.(false)
    await store.renameSession(p.sessionId, title)
    ack?.(true)
  })

  socket.on('pin_session', async (p: { sessionId: string; pinned: boolean }, ack?: (ok: boolean) => void) => {
    if (!(await owns(userId, p.sessionId))) return ack?.(false)
    await store.setPinned(p.sessionId, !!p.pinned)
    ack?.(true)
  })

  /**
   * 删会话：活着的沙箱连锅端（kill 是真删，paused 快照也没了），事件随库级联。
   * 广播 session_deleted 让同用户的其它客户端把它从界面上抹掉。
   */
  socket.on('delete_session', async (p: { sessionId: string }, ack?: (ok: boolean) => void) => {
    if (!(await owns(userId, p.sessionId))) return ack?.(false)
    const l = live.get(p.sessionId)
    if (l) {
      l.bridge?.close()
      live.delete(p.sessionId)
      await l.handle.kill().catch(() => {})
    }
    await store.deleteSession(p.sessionId)
    io.to(p.sessionId).emit('session_deleted', { sessionId: p.sessionId })
    ack?.(true)
  })

  socket.on('join_session', async (p: JoinSessionPayload, ack?: (a: JoinSessionAck | null) => void) => {
    try {
      const session = (await owns(userId, p.sessionId)) ? await store.getSession(p.sessionId) : undefined
      if (!session) return ack?.(null)
      socket.join(p.sessionId)
      touch(p.sessionId)
      const t0 = Date.now()
      const raw = await store.eventsSince(p.sessionId, p.lastMessageId)
      // 全量加载（无游标）走历史压缩：同一动作的终端增量并成一条。
      // 游标续传必须给原始增量，不压。
      const events = p.lastMessageId ? raw : compactHistory(raw)
      console.log(
        `[join] ${p.sessionId} ${raw.length}→${events.length} events, ` +
          `${(JSON.stringify(events).length / 1024).toFixed(0)}KB, ${Date.now() - t0}ms`,
      )
      ack?.({ sessionId: p.sessionId, session, events })
    } catch (e) {
      // PG/TLS 抖动时 ack 必须回（哪怕是 null）—— 不然前端永远停在空时间线
      console.error(`[join] ${p.sessionId} 加载失败:`, e)
      ack?.(null)
    }
  })

  socket.on('leave_session', (p: { sessionId: string }) => {
    socket.leave(p.sessionId)
  })

  socket.on('send_message', async (p: { sessionId: string; text: string; attachments?: Attachment[] }) => {
    if (!(await owns(userId, p.sessionId))) return
    if (!(await hasCredits(userId, p.sessionId))) return
    await deliverMessage(p.sessionId, p.text, true, p.attachments)
  })

  /** 任务执行中途插话 —— pi 的 steer */
  socket.on('steer', async (p: { sessionId: string; text: string; attachments?: Attachment[] }) => {
    if (!(await owns(userId, p.sessionId))) return
    if (!(await hasCredits(userId, p.sessionId))) return
    const l = live.get(p.sessionId)
    const text = withAttachmentNote(p.text, p.attachments)
    // 桥活着才走 steer；休眠/桥死（沙箱被外部暂停过）退回完整的消息流程 ——
    // 唤醒后作为新 prompt 投递。前端的 running 状态可能是重启前的旧快照，
    // 但消息绝不能悄悄丢（线上踩过：僵尸连接里 steer 全进黑洞）。
    if (l && !l.dormant && l.bridge?.steer(text)) {
      touch(p.sessionId)
      emit(p.sessionId, {
        id: nid(),
        type: 'chat',
        timestamp: Date.now(),
        sender: 'user',
        messageType: 'text',
        content: p.text,
        attachments: p.attachments,
      })
      return
    }
    await deliverMessage(p.sessionId, p.text, true, p.attachments)
  })

  socket.on('abort', async (p: { sessionId: string }) => {
    if (!(await owns(userId, p.sessionId))) return
    live.get(p.sessionId)?.bridge?.abort()
  })

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
})

type Attachment = NonNullable<ChatEvent['attachments']>[number]

/**
 * 附件指引只进 prompt 不进气泡：Agent 需要知道文件在哪、叫什么，
 * 用户不需要再看一遍自己刚传的东西（气泡里有 chips）。
 */
function withAttachmentNote(text: string, attachments?: Attachment[]): string {
  if (!attachments?.length) return text
  const list = attachments.map((a) => `${a.path}（${fmtSize(a.size)}）`).join('、')
  return `${text}\n\n（用户随这条消息上传了 ${attachments.length} 个文件，在当前工作目录下：${list}。需要时用工具直接读取。）`
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

/** 投递一条用户消息：落库、确保沙箱在跑、发给 runtime。send_message 和
 *  steer 的兜底路径共用。echoChat=false 用于补投（chat 气泡已经发过一次）。 */
async function deliverMessage(
  sessionId: string,
  text: string,
  echoChat = true,
  attachments?: Attachment[],
): Promise<void> {
  if (!(await store.getSession(sessionId))) return
  touch(sessionId)

  if (echoChat) {
    emit(sessionId, {
      id: nid(),
      type: 'chat',
      timestamp: Date.now(),
      sender: 'user',
      messageType: 'text',
      content: text,
      attachments,
    })
  }

  const promptText = withAttachmentNote(text, attachments)

  try {
    const { bridge } = await ensureRuntime(sessionId)
    // 沙箱刚起来（或刚唤醒）时 WS 可能还没握手完，重试到连上为止。
    // 发没发出去不在这里下结论 —— 写进半开僵尸连接也返回 true（线上踩过），
    // 交给下面的送达闸判。
    await waitAndSend(() => bridge?.prompt(promptText) ?? false)
    // 送达闸：agent_start 是送达到的唯一证据。三条出路 ——
    //  1) 见到 agent_start：送达，完事
    //  2) 会话被判休眠（沙箱确实没了）：立刻走完整流程补投一次
    //     （resume 或新建后重新 prompt），只补一次防循环
    //  3) 超时两头都没见：桥活着但 agent 没反应，诚实报错
    if (echoChat) {
      const verdict = await Promise.race([
        waitAgentStart(sessionId, 75_000).then(() => 'started' as const),
        waitDormant(sessionId, 75_000).then(() => 'dormant' as const),
      ])
      if (verdict === 'dormant') {
        console.warn(`[${sessionId}] prompt 疑似进死窗，补投一次`)
        await deliverMessage(sessionId, text, false, attachments)
        return
      }
      if (verdict !== 'started') throw new Error('agent 未响应（prompt 已发出但 75s 无动静）')
    }
  } catch (e) {
    emit(sessionId, {
      id: nid(),
      type: 'statusUpdate',
      timestamp: Date.now(),
      agentStatus: 'failed',
      brief: '计算环境启动失败',
      description: e instanceof Error ? e.message : String(e),
    })
  }
}

/** 等 agent_start（prompt 送达的证据），超时 false */
function waitAgentStart(sessionId: string, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    function cleanup(): void {
      clearTimeout(timer)
      startWaiters.get(sessionId)?.delete(fn)
    }
    const fn = (): void => { cleanup(); resolve(true) }
    const timer = setTimeout(() => { cleanup(); resolve(false) }, ms)
    let set = startWaiters.get(sessionId)
    if (!set) { set = new Set(); startWaiters.set(sessionId, set) }
    set.add(fn)
  })
}

/** 等会话被判休眠（沙箱死亡的确证），已是休眠/超时立即返回 */
function waitDormant(sessionId: string, ms: number): Promise<boolean> {
  const l = live.get(sessionId)
  if (!l || l.dormant) return Promise.resolve(true)
  return new Promise((resolve) => {
    function cleanup(): void {
      clearTimeout(timer)
      dormantWaiters.get(sessionId)?.delete(fn)
    }
    const fn = (): void => { cleanup(); resolve(true) }
    const timer = setTimeout(() => { cleanup(); resolve(false) }, ms)
    let set = dormantWaiters.get(sessionId)
    if (!set) { set = new Set(); dormantWaiters.set(sessionId, set) }
    set.add(fn)
  })
}

async function waitAndSend(send: () => boolean, tries = 30): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if (send()) return true
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

http.listen(PORT, () => {
  console.log(`socket-server on :${PORT}  model=${MODEL}`)
  console.log(`auth: ${authEnabled ? '强制登录（INSFORGE_URL 已配）' : '开放模式（未配 INSFORGE_URL）'}`)
  if (creditsEnabled) {
    console.log(`credits: 启用（试用 ${TRIAL_CREDITS} / 会话上限 ${SESSION_CREDIT_CAP} / waffo ${waffoEnabled ? '已配' : '未配'}）`)
  }
  console.log(
    process.env.AGENT_RUNTIME_URL
      ? `runtime: local (${process.env.AGENT_RUNTIME_URL})`
      : `runtime: e2b (template=${process.env.E2B_TEMPLATE ?? 'cassia-lite'})`,
  )
  // 密钥随 attach 下发进沙箱。这里一个都没有，沙箱里的 pi 会在第一次
  // LLM 调用时无声死掉 —— 事件流零输出，极难排查（踩过）。启动就喊出来。
  if (Object.keys(pickApiKeys()).length === 0)
    console.warn('⚠️  没有任何 provider key（DEEPSEEK_API_KEY 等）—— 沙箱里的 pi 将无法工作。用 set -a && source .env && set +a 起服务。')
})

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    // 只断 bridge，不杀沙箱。重启/部署不该毁掉用户的电脑 —— DB 记着
    // sandboxId，起来后 ensureRuntime 会透明接回。沙箱闲置费用由 E2B 的
    // lifecycle 兜底：timeout 到点自动 pause，暂停不计费。
    // （混沌测试踩过：这里 kill 沙箱，「重启后接回」就永远是 404。）
    for (const l of live.values()) {
      l.bridge?.close()
    }
    process.exit(0)
  })
}
