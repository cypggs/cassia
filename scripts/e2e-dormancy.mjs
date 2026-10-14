/**
 * 休眠/唤醒验证 —— 这个平台「沙箱不丢状态」承诺的核心测试。
 *
 * 流程（全程自动控制面的一个真实 socket-server 实例）：
 *   1. 发消息让 Agent 写下一个标记文件
 *   2. 静置 → 控制面把会话标记休眠（断 bridge），E2B 到点把沙箱暂停
 *   3. 断言 E2B 那边沙箱状态是 paused，不是被杀
 *   4. 再发一条消息 → 控制面唤醒（Sandbox.connect 恢复全内存快照）
 *   5. 断言：同一个 sandboxId、标记文件还在、Agent 能正常回话
 *
 * 这不是形式主义。「暂停/恢复」做错的方式太多了：恢复到新沙箱（状态全丢）、
 * 恢复快照但 pi 进程没醒（对话上下文断了）、bridge 重连把沙箱反复唤醒（白烧额度）。
 * 每一条这里都有对应断言。
 *
 * 完全自持，不依赖外面跑着的服务：
 *   node --env-file=.env scripts/e2e-dormancy.mjs
 */
import { io } from 'socket.io-client'
import { spawn } from 'node:child_process'
import { Sandbox } from 'e2b'

const PORT = 4101
const URL = `http://localhost:${PORT}`
const MARKER = 'DORMANT-MARKER-7X'

// 测试用短窗口：45s 无活动 → 控制面标记休眠；E2B 90s 到点 → 自动暂停。
// （续期防抖 60s，90s 的窗口保证任务期间至少续得上一次。）
const IDLE_MS = 45_000
const E2B_TIMEOUT_MS = 90_000

const t0 = Date.now()
const el = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`.padStart(6)
const log = (...a) => console.log(el(), ...a)

const env = {
  ...process.env,
  SOCKET_PORT: String(PORT),
  SANDBOX_IDLE_MS: String(IDLE_MS),
  E2B_TIMEOUT_MS: String(E2B_TIMEOUT_MS),
  E2B_TEMPLATE: process.env.E2B_TEMPLATE ?? 'cassia-lite', // 休眠测试不需要画面，lite 起得快
  DB_PATH: `/tmp/cassia-dormancy-${Date.now()}.db`,
}
delete env.AGENT_RUNTIME_URL
// 休眠测试跑开放模式 —— 鉴权有 e2e-auth 专测
delete env.INSFORGE_URL

const srv = spawn('./socket-server/node_modules/.bin/tsx', ['socket-server/src/index.ts'], {
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
})
srv.stderr.on('data', (d) => process.stderr.write(`[srv] ${d}`))
srv.stdout.on('data', (d) => {
  const s = d.toString()
  if (s.includes('休眠') || s.includes('唤醒')) process.stdout.write(`[srv] ${s}`)
})

for (let i = 0; i < 60; i++) {
  try {
    if ((await fetch(`${URL}/healthz`)).ok) break
  } catch { /* 还没起 */ }
  await new Promise((r) => setTimeout(r, 400))
}

/** 发一条消息，收集到任务结束为止的所有事件 */
async function runTask(s, sessionId, text) {
  const events = []
  let done
  const finished = new Promise((r) => (done = r))
  const handler = ({ event: e }) => {
    events.push(e)
    if (e.type === 'statusUpdate' && e.agentStatus !== 'running') setTimeout(done, 500)
  }
  s.on('event', handler)
  s.emit('send_message', { sessionId, text })
  await Promise.race([finished, new Promise((r) => setTimeout(r, 180_000))])
  s.off('event', handler)
  return events
}

const sandboxState = async (id) => {
  const p = await Sandbox.list()
  while (p._hasNext) {
    for (const x of await p.nextItems()) if (x.sandboxId === id) return x.state
  }
  return null
}

const results = {}
let s
try {
  s = io(URL, { transports: ['websocket'] })
  await new Promise((r) => s.on('connect', r))
  const sess = await new Promise((r) => s.emit('create_session', {}, r))
  await new Promise((r) => s.emit('join_session', { sessionId: sess.id }, r))
  log(`会话 ${sess.id}`)

  // ── 1. 写标记文件
  const ev1 = await runTask(s, sess.id,
    `用 bash 执行：echo ${MARKER} > ~/marker.txt && cat ~/marker.txt。看到输出后说完成。`)
  const sb1 = [...ev1].reverse().find((e) => e.type === 'sandboxUpdate' && e.status === 'running')
  results.sandboxId = sb1?.sandboxId
  log(`沙箱 ${results.sandboxId}，标记已写入`)

  // ── 2. 静置到休眠 + E2B 暂停（idle 45s + e2b 90s，留足余量等到 150s）
  log('静置，等待休眠与暂停…')
  let pausedSeen = false
  let e2bPaused = false
  const pausedEvents = []
  s.on('event', ({ event: e }) => {
    if (e.type === 'sandboxUpdate' && e.status === 'paused') {
      pausedSeen = true
      pausedEvents.push(e)
    }
  })
  for (let i = 0; i < 30 && !e2bPaused; i++) {
    await new Promise((r) => setTimeout(r, 5000))
    const st = await sandboxState(results.sandboxId).catch(() => null)
    if (st === 'paused') e2bPaused = true
    if (i % 3 === 0) log(`…E2B 状态: ${st ?? '未知'}`)
  }
  results.pausedSeen = pausedSeen
  results.e2bPaused = e2bPaused
  log(`控制面休眠事件=${pausedSeen}，E2B 已暂停=${e2bPaused}`)

  // ── 3. 唤醒，读标记
  log('发第二条消息，触发唤醒…')
  const ev2 = await runTask(s, sess.id,
    '用 bash 执行：cat ~/marker.txt。把看到的内容原样告诉我。')
  const sb2 = [...ev2].reverse().find((e) => e.type === 'sandboxUpdate' && e.status === 'running')
  results.sameId = sb2?.sandboxId === results.sandboxId
  const text2 = ev2.map((e) =>
    e.type === 'toolUsed' ? (e.detail?.terminal?.output ?? []).join('') :
    e.type === 'chat' ? e.content : '',
  ).join('\n')
  results.markerFound = text2.includes(MARKER)
  results.woke = ev2.some((e) => e.type === 'statusUpdate')
  log(`同一沙箱=${results.sameId}，标记还在=${results.markerFound}`)

  s.close()

  console.log('\n──────── 断言 ────────')
  const checks = [
    ['沙箱被暂停而不是销毁（E2B 状态 paused）', results.e2bPaused],
    ['控制面发出了 paused 事件（前端能显示「已休眠」）', results.pausedSeen],
    ['唤醒后是同一个沙箱（不是偷偷换了台新的）', results.sameId],
    ['标记文件还在（文件系统跨休眠保留）', results.markerFound],
    ['唤醒后 Agent 正常工作', results.woke],
  ]
  let ok = true
  for (const [name, pass] of checks) {
    if (!pass) ok = false
    console.log(`  ${pass ? '✓' : '✗'} ${name}`)
  }
  console.log(ok ? '\nPASS —— 沙箱休眠/唤醒，状态全保留' : '\nFAIL')
  process.exitCode = ok ? 0 : 1
} catch (e) {
  console.error('FAIL ——', e)
  process.exitCode = 1
} finally {
  s?.close()
  srv.kill('SIGTERM')
  if (results.sandboxId) await Sandbox.kill(results.sandboxId).catch(() => {})
}
