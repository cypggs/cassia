/**
 * 持久化验证：socket-server 重启之后，历史会话和事件必须还在。
 *
 * 完全自持 —— 自己起第一个控制面、写一条消息、杀掉、起第二个、验证。
 * 不需要外面先有东西在跑，也不污染外面的 .workspace 数据库（用临时 DB_PATH）。
 *
 *   node scripts/e2e-persistence.mjs
 */
import { io } from 'socket.io-client'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = 4100 // 不和 4000 撞，免得误伤正在跑的开发实例
const URL = `http://localhost:${PORT}`
const TEXT = '持久化验证消息 —— 控制面重启后这条必须还能查到'

const t0 = Date.now()
const el = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`.padStart(6)
const log = (...a) => console.log(el(), ...a)

const work = mkdtempSync(join(tmpdir(), 'cassia-persist-'))
const dbPath = join(work, 'test.db')

function startServer(extra = {}) {
  const env = {
    ...process.env,
    SOCKET_PORT: String(PORT),
    DB_PATH: dbPath,
    // 不连真沙箱 —— 这个测试只验存储层，不该为一个用户消息去烧 E2B 额度
    AGENT_RUNTIME_URL: 'http://127.0.0.1:1', // 指向一个必然失败的地址
    ...extra,
  }
  const child = spawn('./socket-server/node_modules/.bin/tsx', ['socket-server/src/index.ts'], {
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (d) => (stderr += d))
  return { child, getStderr: () => stderr }
}

async function waitHealthy() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${URL}/healthz`)
      if (r.ok) return true
    } catch { /* 还没起 */ }
    await new Promise((r) => setTimeout(r, 400))
  }
  return false
}

async function connect() {
  const s = io(URL, { transports: ['websocket'] })
  await new Promise((r) => s.on('connect', r))
  return s
}

let sessionId
try {
  // ── 第一个实例：写
  let srv = startServer()
  if (!(await waitHealthy())) throw new Error('实例 1 没起来\n' + srv.getStderr())
  let s = await connect()
  const sess = await new Promise((r) => s.emit('create_session', {}, r))
  sessionId = sess.id
  log(`实例 1：会话 ${sessionId}，写入用户消息`)
  s.emit('send_message', { sessionId, text: TEXT })
  await new Promise((r) => setTimeout(r, 800))
  s.close()
  srv.child.kill('SIGTERM')
  await new Promise((r) => setTimeout(r, 800))
  log('实例 1 已停止')

  // ── 第二个实例：同一个 DB，读
  srv = startServer()
  if (!(await waitHealthy())) throw new Error('实例 2 没起来\n' + srv.getStderr())
  s = await connect()
  const list = await new Promise((r) => s.emit('list_sessions', {}, r))
  const mine = list.find((x) => x.id === sessionId)
  const ack = await new Promise((r) => s.emit('join_session', { sessionId }, r))
  s.close()
  srv.child.kill('SIGTERM')
  log('实例 2 已读取')

  console.log('\n──────── 断言 ────────')
  const checks = [
    ['重启后会话仍在列表里', !!mine],
    ['标题（首条用户消息）保留', mine?.title && mine.title !== '新任务'],
    ['标题内容正确', mine?.title === TEXT.slice(0, 40)],
    ['事件能取回', (ack?.events?.length ?? 0) > 0],
  ]
  let ok = true
  for (const [name, pass] of checks) {
    if (!pass) ok = false
    console.log(`  ${pass ? '✓' : '✗'} ${name}`)
  }
  console.log(`  (取回 ${ack?.events?.length ?? 0} 条事件，标题: ${JSON.stringify(mine?.title)})`)
  console.log(ok ? '\nPASS —— 控制面重启不丢历史' : '\nFAIL')
  process.exitCode = ok ? 0 : 1
} catch (e) {
  console.error('FAIL ——', e.message)
  process.exitCode = 1
} finally {
  rmSync(work, { recursive: true, force: true })
}
