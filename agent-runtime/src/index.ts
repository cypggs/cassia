import { createServer } from 'node:http'
import { existsSync, mkdirSync, readdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, type WebSocket } from 'ws'
import type { AgentEvent } from '@cassia/shared'
import { PiClient } from './pi-client.js'
import { Translator } from './translate.js'

/**
 * agent-runtime —— 跑在沙箱里（也可以跑在本机）的那一层。
 *
 * 职责只有三件：驱动 pi、把 pi 的事件翻译成平台事件、把事件推给控制面。
 * 它对「自己在哪」无感知 —— 本机跑和沙箱里跑是同一份代码，
 * 差别只在控制面用什么地址拨过来。这让我们能先在本机把链路走通，
 * 再原样搬进 E2B。
 *
 * **每个会话一个 pi 进程、一个工作目录。** 生产上一个沙箱只服务一个任务，
 * 这个 map 里永远只有一项；但本机开发时多个会话共用一个 runtime，
 * 不隔离的话两个任务的事件会互相串台（而且它们会共享同一份对话上下文）。
 *
 * 上行（控制面 → runtime）：
 *   {type:'attach', sessionId, model?, env?}   ← 必须先发，后续消息都归属这个会话
 *   {type:'prompt', text}  {type:'steer', text}  {type:'abort'}  {type:'bash', command}
 * 下行（runtime → 控制面）：
 *   {type:'event', event: AgentEvent}
 */

const PORT = Number(process.env.PORT ?? 8330)
const WORKSPACE_ROOT = process.env.WORKSPACE ?? process.cwd()
const MODEL = process.env.PI_MODEL ?? 'deepseek/deepseek-flash'
const THINKING = process.env.PI_THINKING ?? 'off'

const BASE_PROMPT = `
你在一个可视化的 Agent 平台里工作，用户能实时看到你的每一步操作。
调用工具前先用一句话说明你要做什么以及为什么 —— 这句话会显示在用户的任务时间线上。
用用户提问所使用的语言作答。
3 步以上的任务必须用 plan 工具建计划并随进展更新 —— 用户有一个专门的计划面板在盯着它。
`.trim()

/**
 * 浏览器能力提示。只在真有图形环境时才追加 —— 用 DISPLAY 判断，
 * cassia 模板设了它，lite 没有。
 *
 * 不能无条件加：告诉一个没有 X 的沙箱「你有浏览器」，模型会去开
 * chromium，然后拿着一串 `cannot open display` 反复重试，
 * 用户在时间线上看到的就是 Agent 在原地打转。
 */
const BROWSER_PROMPT = `
这台机器有图形桌面，用户能在「画面」面板里实时看到它。
桌面上已经有一个常驻的 Chromium 在跑，CDP 端口是 9222。
需要浏览网页时，**接管这个实例**，不要另开 headless 浏览器 ——
只有这个实例的画面用户看得见。用 playwright-core 连上去：

  const { chromium } = require('playwright-core')
  const browser = await chromium.connectOverCDP('http://localhost:9222')
  const page = browser.contexts()[0].pages()[0]
  await page.goto('https://example.com')

playwright-core 是全局安装的，脚本里可能要设 NODE_PATH=$(npm root -g)。
简单场景也可以直接用 xdotool 操作桌面。

用完**不要调 browser.close()**，那会把用户正看着的浏览器关掉，画面会黑一下。
但脚本结尾**必须调 \`await browser.disconnect()\`** 再退出 —— CDP 连接会
撑住 node 事件循环，不断开的话脚本打印完输出也不退出，命令一直挂到超时。
close 杀浏览器，disconnect 只断开连接，浏览器照常开着。
`.trim()

const SYSTEM_APPEND = process.env.DISPLAY
  ? `${BASE_PROMPT}\n\n${BROWSER_PROMPT}`
  : BASE_PROMPT

/**
 * pi 扩展的位置。本机开发时 runtime 源在 agent-runtime/src、
 * 扩展在 agent-runtime/pi-extension；镜像里编译产物在 /opt/cassia/runtime、
 * 扩展在 /opt/cassia/pi-extension —— 两种布局下都是 ../pi-extension。
 * 找不到就不加载（bash 退回 pi 默认的每次新 shell、计划面板沉默），
 * 不让扩展缺失变成 runtime 起不来。
 */
const SHELL_EXTENSION = fileURLToPath(new URL('../pi-extension/persistent-shell.ts', import.meta.url))
const PLAN_EXTENSION = fileURLToPath(new URL('../pi-extension/plan.ts', import.meta.url))
const EXTENSIONS = [SHELL_EXTENSION, PLAN_EXTENSION].filter(existsSync)

interface Agent {
  pi: PiClient
  translator: Translator
  clients: Set<WebSocket>
  /** 重建 pi 要用的原始配置（model/env 来自首次 attach） */
  opts: AttachOpts
  /** 自愈进行中 —— 看门狗和 exit 处理器都别重复触发 */
  reviving: boolean
  /** 自愈窗口里收到的消息 —— 旧 pi 已死、新 pi 没好，先攒着，自愈完补发 */
  pendingMsgs: Array<{ type: 'prompt' | 'steer'; text: string }>
  /** 自愈尝试时间戳（限频：10 分钟内最多 3 次，防死亡循环） */
  reviveLog: number[]
}

/** attach 时控制面可以带的会话级配置 */
interface AttachOpts {
  model?: string
  /** provider 的 API key。镜像里不烤密钥，运行时也不依赖 E2B 的 envs 时序。 */
  env?: Record<string, string>
}

const agents = new Map<string, Agent>()

function broadcast(sessionId: string, event: AgentEvent): void {
  const a = agents.get(sessionId)
  if (!a) return
  const frame = JSON.stringify({ type: 'event', event })
  for (const ws of a.clients) {
    if (ws.readyState === ws.OPEN) ws.send(frame)
  }
}

function getAgent(sessionId: string, opts: AttachOpts = {}): Agent {
  const existing = agents.get(sessionId)
  if (existing) return existing

  const agent: Agent = {
    pi: null as unknown as PiClient, // spawnPi 立刻填上
    translator: new Translator(),
    clients: new Set(),
    opts,
    reviving: false,
    pendingMsgs: [],
    reviveLog: [],
  }
  agents.set(sessionId, agent)
  spawnPi(sessionId, agent)
  return agent
}

/**
 * 为会话起一个 pi 进程并接好所有线。首次创建和看门狗自愈共用。
 *
 * pi 退出（崩溃/被杀）不直接删会话 —— 交给 reviveAgent 重建并接回
 * 落盘的会话上下文（pi 把会话写在 ~/.pi/agent/sessions/<编码cwd>/，
 * 实测接回后上下文完整，见 scripts/probe-pirevive.mjs）。
 */
function spawnPi(sessionId: string, agent: Agent): void {
  const cwd = join(WORKSPACE_ROOT, sessionId)
  mkdirSync(cwd, { recursive: true })

  const pi = new PiClient({
    cwd,
    model: agent.opts.model ?? MODEL,
    thinking: THINKING,
    systemPromptAppend: SYSTEM_APPEND,
    env: agent.opts.env,
    extensions: EXTENSIONS,
  })
  agent.pi = pi

  pi.on('event', (ev) => {
    for (const out of agent.translator.translate(ev)) broadcast(sessionId, out)
  })
  pi.on('stderr', (s: string) => console.error(`[pi ${sessionId}]`, s.trimEnd()))
  pi.on('error', (e: Error) => console.error(`[pi ${sessionId}] spawn error:`, e.message))
  pi.on('ready', () => console.log(`[pi ${sessionId}] rpc ready  cwd=${cwd}`))
  pi.on('exit', (code: number | null) => {
    console.error(`[pi ${sessionId}] exited with ${code}`)
    // 自愈流程自己杀的 pi，exit 是它预料内的事，别重复触发
    if (agent.reviving) return
    void reviveAgent(sessionId, `进程退出 code=${code}`)
  })

  pi.start()
}

/**
 * pi 崩溃自愈：杀掉旧进程 → 重起 → switch_session 接回落盘上下文 →
 * 广播诚实的状态（不假装什么都没发生，也不假装还在跑）。
 *
 * 触发点两个：exit 处理器（崩溃）和看门狗（卡住不动，比如跨沙箱暂停
 * 恢复的悬挂 HTTPS 请求 —— 线上踩过，只能手动杀进程）。
 */
async function reviveAgent(sessionId: string, reason: string): Promise<void> {
  const agent = agents.get(sessionId)
  if (!agent || agent.reviving) return
  agent.reviving = true

  // 限频：10 分钟内第 4 次放弃 —— 反复死说明病根不在进程，循环重建只会
  // 把 provider key 的请求配额烧光
  const now = Date.now()
  agent.reviveLog = agent.reviveLog.filter((t) => now - t < 10 * 60_000)
  if (agent.reviveLog.length >= 3) {
    console.error(`[pi ${sessionId}] 自愈超过限频，放弃`)
    broadcast(sessionId, {
      id: `revive-giveup-${sessionId}-${now}`,
      type: 'statusUpdate',
      timestamp: now,
      agentStatus: 'failed',
      brief: 'Agent 进程反复异常',
      description: '自动恢复多次失败，请发新消息重试',
    })
    agents.delete(sessionId)
    return
  }
  agent.reviveLog.push(now)
  console.error(`[pi ${sessionId}] 看门狗触发自愈: ${reason}`)

  // 先记下旧会话文件 —— 新 pi 一起身就会写自己的空会话文件，
  // 之后再找「最新」找到的就是那个空的，上下文接不回来
  const sessionFile = latestSessionFile(join(WORKSPACE_ROOT, sessionId))

  agent.pi.stop()
  // stop 是 SIGTERM + 5s 后 SIGKILL，等它死透再重起，免得两个 pi 抢会话文件
  await new Promise((r) => setTimeout(r, 6_000))

  spawnPi(sessionId, agent)
  agent.translator = new Translator() // 旧翻译器的状态属于死掉的那一轮

  try {
    // pi 起来不会自发打 response（ready 是「第一条命令的响应」），
    // 主动发一条 get_state —— 有响应才算 RPC 循环真的活了
    await agent.pi.request('get_state', {}, 30_000)
    let restored = false
    if (sessionFile) {
      const r = await agent.pi.switchSession(sessionFile).catch(() => null)
      restored = !!r && r.success === true
    }
    broadcast(sessionId, {
      id: `revived-${sessionId}-${Date.now()}`,
      type: 'statusUpdate',
      timestamp: Date.now(),
      agentStatus: 'stopped',
      brief: 'Agent 进程异常，已自动恢复',
      description: restored ? '上下文已接回，可以继续' : '上下文未能接回，相当于重新开始',
    })
    console.error(`[pi ${sessionId}] 自愈完成，上下文${restored ? '已接回' : '未接回'}`)
  } catch (e) {
    console.error(`[pi ${sessionId}] 自愈失败:`, e instanceof Error ? e.message : e)
    broadcast(sessionId, {
      id: `revive-fail-${sessionId}-${Date.now()}`,
      type: 'statusUpdate',
      timestamp: Date.now(),
      agentStatus: 'failed',
      brief: 'Agent 进程异常且自动恢复失败',
      description: e instanceof Error ? e.message : String(e),
    })
  } finally {
    agent.reviving = false
    // 补发自愈窗口里攒下的消息 —— 用户在恢复期间说的话不能丢
    for (const m of agent.pendingMsgs.splice(0)) {
      try {
        if (m.type === 'prompt') agent.pi.prompt(m.text)
        else agent.pi.steer(m.text)
      } catch (e) {
        console.error(`[pi ${sessionId}] 补发消息失败:`, e instanceof Error ? e.message : e)
      }
    }
  }
}

/** pi 把会话写在 ~/.pi/agent/sessions/<编码cwd>/<时间戳>_<uuid>.jsonl */
function latestSessionFile(cwd: string): string | undefined {
  // pi 编码的是 realpath 后的 cwd（macOS 的 /tmp → /private/tmp，实测踩过）
  let real = resolve(cwd)
  try { real = realpathSync(real) } catch { /* 目录不存在就按原样 */ }
  const safe = `--${real.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
  const dir = join(homedir(), '.pi/agent/sessions', safe)
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()
    return files.length ? join(dir, files[files.length - 1]) : undefined
  } catch {
    return undefined
  }
}

/**
 * 看门狗：每分钟对每个会话的 pi 发 get_state 探活。
 * 健康但忙碌的 pi 也会逐行处理 RPC，15s 不答就是卡死了
 * （跨沙箱暂停恢复的悬挂连接、死锁 —— 都不会自己好）。
 */
const WATCHDOG_MS = Number(process.env.PI_WATCHDOG_MS ?? 60_000)
const watchdog = setInterval(() => {
  for (const [sessionId, agent] of agents) {
    if (agent.reviving) continue
    void agent.pi.ping(15_000).then((alive) => {
      if (!alive) void reviveAgent(sessionId, 'get_state 15s 无响应')
    })
  }
}, WATCHDOG_MS)
watchdog.unref()

const server = createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      ok: true,
      workspace: WORKSPACE_ROOT,
      model: MODEL,
      sessions: [...agents.keys()],
    }))
    return
  }
  res.writeHead(404).end()
})

const wss = new WebSocketServer({ server, path: '/ws' })

wss.on('connection', (ws) => {
  let sessionId: string | null = null

  ws.on('message', (raw) => {
    let msg: {
      type?: string
      sessionId?: string
      text?: string
      command?: string
      model?: string
      env?: Record<string, string>
    }
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }

    if (msg.type === 'attach') {
      if (!msg.sessionId) return
      sessionId = msg.sessionId
      // model / env 只在会话首次创建时生效；重连不会重启已有的 pi 进程
      getAgent(sessionId, { model: msg.model, env: msg.env }).clients.add(ws)
      console.log(`[ws] attached to ${sessionId}`)
      return
    }

    // attach 之前的任何指令都丢弃 —— 没有会话归属就没法路由
    if (!sessionId) return
    const agent = getAgent(sessionId)
    const { pi } = agent

    switch (msg.type) {
      case 'prompt':
      case 'steer': {
        if (!msg.text) break
        // 自愈窗口里旧 pi 已死、新 pi 没好 —— 直接发会写进死进程的
        // stdin 黑洞（混沌测试踩过）。攒着，自愈完补发。
        if (agent.reviving) {
          agent.pendingMsgs.push({ type: msg.type, text: msg.text })
          break
        }
        if (msg.type === 'prompt') pi.prompt(msg.text)
        else pi.steer(msg.text)
        break
      }
      case 'abort':
        pi.abort()
        break
      case 'bash':
        if (msg.command) pi.bash(msg.command)
        break
    }
  })

  ws.on('close', () => {
    if (sessionId) agents.get(sessionId)?.clients.delete(ws)
  })
})

server.listen(PORT, () => {
  console.log(`agent-runtime on :${PORT}  workspace=${WORKSPACE_ROOT}  model=${MODEL}`)
})

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    for (const a of agents.values()) a.pi.stop()
    server.close(() => process.exit(0))
  })
}
