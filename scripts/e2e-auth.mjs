/**
 * 鉴权与多用户隔离 e2e（InsForge 内省模式）：自起一个带 INSFORGE_URL 的
 * socket-server（独立端口、独立 DB，不碰开发中的 :4000），用真实的
 * InsForge 测试用户令牌断言：
 *   ① 无令牌连接被拒
 *   ② 假令牌连接被拒
 *   ③ A 建的会话不出现在 B 的列表里
 *   ④ B join A 的会话被拒（按不存在处理，防枚举）
 *   ⑤ B 访问 A 的文件端点 404，无令牌 401
 *   ⑥ A 的完整链路照常（登录态没把正路打破）
 *
 * 测试用户（e2e-a/e2e-b@cassia.dev）是一次性建在 InsForge 项目里的，
 * 不在就现场注册。需要 .env 里有 NEXT_PUBLIC_INSFORGE_URL 和 NEXT_PUBLIC_INSFORGE_ANON_KEY。
 *
 *   node --env-file=.env scripts/e2e-auth.mjs
 */
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { io } from 'socket.io-client'

// 开发库（.env）里只有 NEXT_PUBLIC_INSFORGE_URL（前端用）；socket-server 的
// 鉴权开关是裸 INSFORGE_URL，这里显式注入 —— 鉴权模式不进 .env，
// 否则开发的 :4000 会强制登录，全部连 :4000 的测试脚本都得跟着带令牌。
const INSFORGE_URL = (process.env.INSFORGE_URL ?? process.env.NEXT_PUBLIC_INSFORGE_URL)?.replace(/\/$/, '')
const ANON_KEY = process.env.NEXT_PUBLIC_INSFORGE_ANON_KEY
if (!INSFORGE_URL || !ANON_KEY) {
  console.error('需要 .env 里有 NEXT_PUBLIC_INSFORGE_URL 和 NEXT_PUBLIC_INSFORGE_ANON_KEY')
  process.exit(1)
}

const PORT = 4099
const BASE = `http://localhost:${PORT}`
const t0 = Date.now()
const el = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`.padStart(6)
const log = (...a) => console.log(el(), ...a)
let pass = true
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`)
  if (!ok) pass = false
}

// ── 拿真实用户令牌：先尝试登录，用户不存在就注册后再登录 ──
async function userToken(email, password) {
  const signIn = () =>
    fetch(`${INSFORGE_URL}/api/auth/sessions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ANON_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }).then((r) => r.json())

  let body = await signIn()
  if (!body.accessToken) {
    await fetch(`${INSFORGE_URL}/api/auth/users`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ANON_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    body = await signIn()
  }
  if (!body.accessToken) throw new Error(`拿不到 ${email} 的令牌：${JSON.stringify(body)}`)
  return body.accessToken
}

// ── 起一台带鉴权的控制面（独立 DB，免得污染开发库）────────
// 默认 SQLite（临时目录）；设了 E2E_DATABASE_URL 则走 PG（test:auth:pg，
// 直连 InsForge Postgres —— 跑完会把本测试建的会话删掉，不留在库里）。
const DATABASE_URL = process.env.E2E_DATABASE_URL
const dbDir = mkdtempSync(join(tmpdir(), 'auth-e2e-'))
const srv = spawn('./socket-server/node_modules/.bin/tsx', ['socket-server/src/index.ts'], {
  env: {
    ...process.env,
    SOCKET_PORT: String(PORT),
    ...(DATABASE_URL ? { DATABASE_URL } : { DB_PATH: join(dbDir, 'test.db') }),
    INSFORGE_URL, // 显式开鉴权（见上方注释）
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
srv.stdout.on('data', (d) => process.stdout.write(`[srv] ${d}`))
srv.stderr.on('data', (d) => process.stdout.write(`[srv!] ${d}`))
process.on('exit', () => srv.kill())

for (let i = 0; i < 60; i++) {
  const ok = await fetch(`${BASE}/healthz`).then((r) => r.ok).catch(() => false)
  if (ok) break
  await new Promise((r) => setTimeout(r, 500))
  if (i === 59) { console.error('控制面没起来'); process.exit(1) }
}
log(`控制面就绪（InsForge 鉴权模式，${DATABASE_URL ? 'PostgreSQL' : 'SQLite'} 存储）`)

const connect = (token) =>
  new Promise((resolve) => {
    const s = io(BASE, { transports: ['websocket'], auth: token ? { token } : undefined, reconnection: false })
    s.on('connect', () => resolve({ s, ok: true }))
    s.on('connect_error', () => { s.close(); resolve({ ok: false }) })
  })
const emit = (s, ev, p) => new Promise((r) => s.emit(ev, p, r))

// ① 无令牌
{
  const { ok } = await connect(null)
  check('无令牌连接被拒', !ok)
}
// ② 假令牌
{
  const { ok } = await connect('garbage.token.here')
  check('假令牌连接被拒', !ok)
}

// A、B 两个真实 InsForge 用户
const tokenA = await userToken('e2e-a@cassia.dev', 'e2e-test-pass-1')
const tokenB = await userToken('e2e-b@cassia.dev', 'e2e-test-pass-2')
const { s: sa, ok: okA } = await connect(tokenA)
const { s: sb, ok: okB } = await connect(tokenB)
check('合法令牌连接成功', okA && okB)

// ③ 列表隔离
const sessA = await emit(sa, 'create_session', {})
const listB = await emit(sb, 'list_sessions', {})
check('A 的会话不出现在 B 的列表', !listB.some((x) => x.id === sessA.id))

// ④ join 被拒
{
  const ack = await emit(sb, 'join_session', { sessionId: sessA.id })
  check('B join A 的会话被拒', ack === null)
}

// ⑤ 文件端点
{
  const noTok = await fetch(`${BASE}/sessions/${sessA.id}/files`)
  const asB = await fetch(`${BASE}/sessions/${sessA.id}/files`, {
    headers: { Authorization: `Bearer ${tokenB}` },
  })
  const dl = await fetch(`${BASE}/sessions/${sessA.id}/file?path=uploads/x.txt`, {
    headers: { Authorization: `Bearer ${tokenB}` },
  })
  check('无令牌访问文件端点 401', noTok.status === 401)
  check('B 访问 A 的文件列表 404', asB.status === 404)
  check('B 下载 A 的文件 404', dl.status === 404)
}

// ⑥ A 的完整链路：建会话 → 发任务 → 终端输出到达
{
  await emit(sa, 'join_session', { sessionId: sessA.id })
  let terminal = ''
  let done
  const finished = new Promise((r) => (done = r))
  sa.on('event', ({ event: e }) => {
    if (e.type === 'toolUsed' && e.detail?.terminal?.output) terminal += e.detail.terminal.output.join('')
    if (e.type === 'statusUpdate' && e.agentStatus !== 'running') setTimeout(done, 500)
  })
  sa.emit('send_message', { sessionId: sessA.id, text: '用 bash 执行：echo auth-e2e-ok。执行完说一句完成。' })
  await Promise.race([finished, new Promise((r) => setTimeout(r, 180_000))])
  check('A 的完整链路照常（终端输出到达）', terminal.includes('auth-e2e-ok'))
}

// ⑦ B 不能动 A 的会话（rename/pin/delete 一律按不存在处理，防枚举）
{
  const r1 = await emit(sb, 'rename_session', { sessionId: sessA.id, title: 'x' })
  const r2 = await emit(sb, 'pin_session', { sessionId: sessA.id, pinned: true })
  const r3 = await emit(sb, 'delete_session', { sessionId: sessA.id })
  check('B 对 A 的会话 rename/pin/delete 均被拒', r1 === false && r2 === false && r3 === false)
}

// ⑦.5 B 的 Console 不能动 A 的会话（start 显式拒绝，input/resize/close 静默丢弃）
{
  const r = await emit(sb, 'console_start', { sessionId: sessA.id, cols: 80, rows: 24 })
  check('B 对 A 的 console_start 被拒', r?.ok === false)
  sb.emit('console_input', { sessionId: sessA.id, data: 'touch /tmp/should_not_exist\n' })
  sb.emit('console_resize', { sessionId: sessA.id, cols: 100, rows: 30 })
  sb.emit('console_close', { sessionId: sessA.id })
  check('B 对 A 的 console input/resize/close 静默丢弃（不报错不生效）', true)
}

// ⑧ 重命名 + 置顶（新建一条更新的会话垫底，置顶后 sessA 必须反超到第一）
{
  const r = await emit(sa, 'rename_session', { sessionId: sessA.id, title: '改名后的任务' })
  const sessA2 = await emit(sa, 'create_session', {})
  await emit(sa, 'pin_session', { sessionId: sessA.id, pinned: true })
  const list = await emit(sa, 'list_sessions', {})
  const me = list.find((x) => x.id === sessA.id)
  check('重命名生效', r === true && me?.title === '改名后的任务')
  check('置顶后反超到列表第一', list[0]?.id === sessA.id && !!me?.pinnedAt)
  await emit(sa, 'delete_session', { sessionId: sessA2.id }) // 顺手清掉陪跑会话
}

// ⑨ 删除：列表消失、join 按不存在处理
{
  const r = await emit(sa, 'delete_session', { sessionId: sessA.id })
  const list = await emit(sa, 'list_sessions', {})
  const joinAck = await emit(sa, 'join_session', { sessionId: sessA.id })
  check(
    '删除后列表消失且 join 被拒',
    r === true && !list.some((x) => x.id === sessA.id) && joinAck === null,
  )
}

sa.close()
sb.close()
srv.kill()
// PG 模式直连的是真实 InsForge 库 —— 把本测试建的会话（事件随外键级联）清掉
if (DATABASE_URL) {
  const { createRequire } = await import('node:module')
  const pg = createRequire(new URL('../socket-server/package.json', import.meta.url))('pg')
  const client = new pg.Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } })
  await client.connect()
  await client.query('DELETE FROM public.sessions WHERE id = $1', [sessA.id])
  await client.end()
  log('已清理 PG 里的测试会话')
}

console.log(pass ? '\nPASS' : '\nFAIL')
process.exit(pass ? 0 : 1)
