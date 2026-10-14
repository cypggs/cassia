/**
 * 混沌 e2e —— 把线上踩过的四类「中途死亡」锁进测试：
 *
 *   A. 任务中途杀掉沙箱（E2B kill） → 下条消息必须恢复（新沙箱），
 *      且控制面要诚实发事件，不能假装还在跑
 *   B. 任务完成后杀掉沙箱里的 pi → 看门狗自动重起、上下文接回
 *   C. 任务中途重启 socket-server → live 表丢了，但 DB 记着 sandbox_id，
 *      下条消息透明接回原沙箱（同一台机器，文件还在）。
 *      注意：控制面关机**不杀沙箱**（重启不该毁掉用户的电脑），
 *      这本身就是被测语义
 *   D. 运行中但长期零事件（pi 僵死/settled 丢失）→ 成本安全带强制收尾
 *
 * 自持：自己起两个 socket-server 实例（不同端口、独立 DB），不依赖外部服务。
 *
 *   node --env-file=.env scripts/e2e-chaos.mjs
 */
import { io } from 'socket.io-client'
import { spawn } from 'node:child_process'
import { Sandbox } from 'e2b'

const t0 = Date.now()
const el = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`.padStart(6)
const log = (...a) => console.log(el(), ...a)

let nextPort = 4201
const servers = []

/** 起一个独立 socket-server，返回控制柄 */
function startServer(template = 'cassia-lite', extraEnv = {}) {
  const port = nextPort++
  const env = {
    ...process.env,
    SOCKET_PORT: String(port),
    E2B_TEMPLATE: template,
    SANDBOX_IDLE_MS: '600000',
    E2B_TIMEOUT_MS: '1800000',
    DB_PATH: `/tmp/cassia-chaos-${port}-${Date.now()}.db`,
    ...extraEnv,
  }
  delete env.AGENT_RUNTIME_URL
  // 韧性/持久化测试跑开放模式 —— 鉴权有 e2e-auth 专测，这里不混进来
  delete env.INSFORGE_URL
  const srv = spawn('./socket-server/node_modules/.bin/tsx', ['socket-server/src/index.ts'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  srv.stderr.on('data', (d) => process.stderr.write(`[srv${port}!] ${d}`))
  servers.push(srv)
  return { port, srv, url: `http://localhost:${port}` }
}

async function waitHealthy(url) {
  for (let i = 0; i < 90; i++) {
    try { if ((await fetch(`${url}/healthz`)).ok) return } catch {}
    await new Promise((r) => setTimeout(r, 400))
  }
  throw new Error(`${url} 起不来`)
}

/** 连上、建会话、发消息，等 doneWhen 命中（默认：agent 非 running 状态） */
async function runTask(url, sessionId, text, capMs = 180_000, doneWhen) {
  const s = io(url, { transports: ['websocket'] })
  await new Promise((r) => s.on('connect', r))
  const events = []
  if (sessionId) {
    await new Promise((r) => s.emit('join_session', { sessionId }, r))
  } else {
    sessionId = await new Promise((r) => s.emit('create_session', {}, (sess) => r(sess.id)))
    await new Promise((r) => s.emit('join_session', { sessionId }, r))
  }
  let done
  const finished = new Promise((r) => (done = r))
  const isDone = doneWhen ?? ((e) => e.type === 'statusUpdate' && e.agentStatus !== 'running')
  const handler = ({ event: e }) => {
    events.push(e)
    if (isDone(e, events)) setTimeout(done, 800)
  }
  s.on('event', handler)
  s.emit('send_message', { sessionId, text })
  await Promise.race([finished, new Promise((r) => setTimeout(r, capMs))])
  s.close()
  return { sessionId, events }
}

const outputsOf = (events) =>
  events.filter((e) => e.type === 'toolUsed' && e.detail?.terminal)
    .map((e) => e.detail.terminal.output.join(''))

const textsOf = (events) =>
  events.filter((e) => e.type === 'chat' && e.sender === 'assistant').map((e) => e.content)

let pass = true
const check = (name, ok) => { console.log(`  ${ok ? '✓' : '✗'} ${name}`); if (!ok) pass = false }

// 沙箱清场：控制面关机不再杀沙箱（生产语义：重启不该毁掉用户的电脑，
// 闲置由 E2B 自动 pause 兜底），测试遗留的沙箱要自己收，不然白挂 30 分钟
const killSandboxes = async (...ids) => {
  for (const id of ids.filter(Boolean)) await Sandbox.kill(id).catch(() => {})
}

// ════════ A. 任务中途杀沙箱 ════════
{
  log('═══ A: 任务中途杀掉沙箱')
  const { port, srv, url } = startServer()
  await waitHealthy(url)

  // 第一条：让它写个文件（顺便拿到 sandboxId）
  const r1 = await runTask(url, null, '用 bash 执行 echo chaos-A-ok > /tmp/chaosA.txt && cat /tmp/chaosA.txt。完成后说完成。')
  const sid1 = r1.events.find((e) => e.type === 'sandboxUpdate')?.sandboxId
  check('沙箱起来了', !!sid1)

  // 直接把沙箱杀了 —— 模拟 E2B 侧沙箱消失（快照过期/被回收/事故）
  await Sandbox.kill(sid1).catch(() => {})
  log(`沙箱 ${sid1} 已被外部杀掉，发下一条消息…`)

  // 下条消息：bridge 会先 502 循环 → unreachable → 休眠 → resume 失败 → 新建。
  // unreachable 判定要 ~2.5 分钟，给足时间
  const r2 = await runTask(url, r1.sessionId, '用 bash 执行 echo chaos-A-after。完成后说完成。', 360_000)
  const sid2 = r2.events.find((e) => e.type === 'sandboxUpdate' && e.status === 'running')?.sandboxId
  const recovered = outputsOf(r2.events).some((o) => o.includes('chaos-A-after'))
  check('控制面诚实标记了休眠/重建（不假装还在跑）',
    r2.events.some((e) => e.type === 'sandboxUpdate' && e.status === 'paused') ||
    r2.events.some((e) => e.type === 'liveStatus'))
  check('任务恢复了（新沙箱上执行成功）', recovered)
  check('换了新沙箱（不假装还是原来那台）', !!sid2 && sid2 !== sid1)
  srv.kill()
  await killSandboxes(sid2)
}

// ════════ B. 杀 pi，看门狗自愈 ════════
{
  log('═══ B: 杀掉沙箱里的 pi，看门狗自愈')
  const { srv, url } = startServer()
  await waitHealthy(url)

  const r1 = await runTask(url, null, '记住数字 6789。只回复 ok。')
  const sid = r1.events.find((e) => e.type === 'sandboxUpdate')?.sandboxId
  check('沙箱起来了', !!sid)

  // 进沙箱杀 pi（runtime 的子进程，cmdline 就是 pi）
  const sbx = await Sandbox.connect(sid)
  const killed = await sbx.commands.run("pkill -9 -x pi && echo killed || echo notfound", { timeout: 10000 })
  check('pi 被杀掉', killed.stdout.includes('killed'))

  // 看门狗：exit 立即触发自愈；恢复后问它记的数字。
  // doneWhen 必须等「回答出现」—— 自愈广播本身就是 statusUpdate stopped，
  // 用默认完成条件会在答案到达前提前收工（踩过，误报上下文丢失）
  const r2 = await runTask(
    url, r1.sessionId,
    '我刚才让你记的数字是什么？只回答数字。',
    300_000,
    (e) => e.type === 'chat' && e.sender === 'assistant',
  )
  const recovered = textsOf(r2.events).some((t) => t.includes('6789'))
  check('收到自动恢复的诚实事件', r2.events.some((e) => (e.brief ?? '').includes('自动恢复')))
  check('上下文接回来了（记得 6789）', recovered)
  srv.kill()
  await killSandboxes(sid)
}

// ════════ C. 任务中途重启 socket-server ════════
{
  log('═══ C: 重启 socket-server，透明接回原沙箱')
  const port = nextPort++
  const env = {
    ...process.env,
    SOCKET_PORT: String(port),
    E2B_TEMPLATE: 'cassia-lite',
    SANDBOX_IDLE_MS: '600000',
    E2B_TIMEOUT_MS: '1800000',
    DB_PATH: `/tmp/cassia-chaos-${port}-${Date.now()}.db`,
  }
  delete env.AGENT_RUNTIME_URL
  // 韧性/持久化测试跑开放模式 —— 鉴权有 e2e-auth 专测，这里不混进来
  delete env.INSFORGE_URL
  const url = `http://localhost:${port}`
  const boot = () => {
    const srv = spawn('./socket-server/node_modules/.bin/tsx', ['socket-server/src/index.ts'], {
      env, stdio: ['ignore', 'pipe', 'pipe'],
    })
    srv.stderr.on('data', (d) => process.stderr.write(`[srvC!] ${d}`))
    servers.push(srv)
    return srv
  }
  let srv = boot()
  await waitHealthy(url)

  const r1 = await runTask(url, null, '用 bash 执行 echo chaos-C-persist > /tmp/chaosC.txt && cat /tmp/chaosC.txt。完成后说完成。')
  const sid1 = r1.events.find((e) => e.type === 'sandboxUpdate')?.sandboxId
  check('沙箱起来了', !!sid1)

  // 重启控制面 —— live 表清空，但 DB（同一个文件）记着 sandbox_id
  srv.kill()
  await new Promise((r) => setTimeout(r, 2000))
  srv = boot()
  await waitHealthy(url)
  log('控制面已重启，发下一条消息…')

  const r2 = await runTask(url, r1.sessionId, '用 bash 执行 cat /tmp/chaosC.txt。把输出原样告诉我。')
  const back = outputsOf(r2.events).some((o) => o.includes('chaos-C-persist'))
  check('接回了同一个沙箱（文件还在）', back)
  srv.kill()
  await killSandboxes(sid1)
}

// ════════ D. 成本安全带：运行中但零事件 → 强制收尾 ════════
{
  log('═══ D: 僵死运行会话被强制收尾')
  const { srv, url } = startServer('cassia-lite', {
    STUCK_RUN_MS: '20000',
    SANDBOX_IDLE_MS: '45000', // reap 间隔 = 15s
  })
  await waitHealthy(url)

  // sleep 300：工具开始事件之后就是长久的沉默，agentRunning 一直 true
  const s = io(url, { transports: ['websocket'] })
  await new Promise((r) => s.on('connect', r))
  const sess = await new Promise((r) => s.emit('create_session', {}, r))
  await new Promise((r) => s.emit('join_session', { sessionId: sess.id }, r))
  const events = []
  s.on('event', ({ event: e }) => events.push(e))
  s.emit('send_message', { sessionId: sess.id, text: '用 bash 执行 sleep 300，timeout 设 320。执行完说完成。' })

  // 安全带应在 ~30-60s 内触发（STUCK 20s + reap 15s 周期），给 150s
  const deadline = Date.now() + 150_000
  while (Date.now() < deadline) {
    if (events.some((e) => (e.brief ?? '').includes('长时间无进展'))) break
    await new Promise((r) => setTimeout(r, 2000))
  }
  s.close()
  check('收到「长时间无进展」的诚实停止事件', events.some((e) => (e.brief ?? '').includes('长时间无进展')))
  check('会话被判休眠（paused 事件）', events.some((e) => e.type === 'sandboxUpdate' && e.status === 'paused'))
  srv.kill()
  await killSandboxes(events.find((e) => e.type === 'sandboxUpdate')?.sandboxId)
}

for (const s of servers) s.kill()
console.log(pass ? '\nPASS —— 四类中途死亡都能恢复' : '\nFAIL')
process.exit(pass ? 0 : 1)
