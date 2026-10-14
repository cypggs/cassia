/**
 * 积分治理 e2e：自起一个带鉴权 + 积分 + 调试后门的控制面（独立端口、独立
 * DB），用每轮唯一的真实 InsForge 测试用户断言完整账务链路：
 *
 *   ① 新用户自动到账 100 试用积分，ledger 记 trial
 *   ② get_wallet 返回三档充值包 + waffo 已配
 *   ③ 余额扣到 ≤0 后 send_message 被拒（收到 insufficient_credits 状态事件）
 *   ④ debug_grant 入账后余额恢复（wallet_update 推送到达）
 *   ⑤ 真任务跑完：usageReport 带积分快照、余额/流水/usage 三处一致
 *   ⑥ 会话预算保险丝：SESSION_CREDIT_CAP=1，首轮扣费后即触发 budget cap
 *
 * 默认 SQLite（临时目录）；设 E2E_DATABASE_URL 走 PG（跑完清掉测试用户的
 * 全部账务行）。⑤ 要真实沙箱 + 模型，需要 .env 里的 E2B / provider key。
 *
 *   node --env-file=.env scripts/e2e-credits.mjs
 */
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { io } from 'socket.io-client'

const INSFORGE_URL = (process.env.INSFORGE_URL ?? process.env.NEXT_PUBLIC_INSFORGE_URL)?.replace(/\/$/, '')
const ANON_KEY = process.env.NEXT_PUBLIC_INSFORGE_ANON_KEY
if (!INSFORGE_URL || !ANON_KEY) {
  console.error('需要 .env 里有 NEXT_PUBLIC_INSFORGE_URL 和 NEXT_PUBLIC_INSFORGE_ANON_KEY')
  process.exit(1)
}

const PORT = 4098
const BASE = `http://localhost:${PORT}`
const TRIAL = 100
const t0 = Date.now()
const el = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`.padStart(6)
const log = (...a) => console.log(el(), ...a)
let pass = true
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`)
  if (!ok) pass = false
}

// ── 每轮唯一的测试用户：trial 断言要精确等值，不能被上轮残留干扰 ──
const EMAIL = `e2e-c-${Date.now()}@cassia.dev`
const PASSWORD = 'e2e-credits-pass'

/** InsForge 链路偶发 TLS 抖动 —— 测试不该死在网络噪声上，重试几次 */
async function fetchRetry(url, opts, tries = 6) {
  let lastErr
  for (let i = 0; i < tries; i++) {
    try {
      return await fetch(url, opts)
    } catch (e) {
      lastErr = e
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)))
    }
  }
  throw lastErr
}

async function userToken(email, password) {
  const signIn = () =>
    fetchRetry(`${INSFORGE_URL}/api/auth/sessions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ANON_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }).then((r) => r.json())
  let body = await signIn()
  if (!body.accessToken) {
    await fetchRetry(`${INSFORGE_URL}/api/auth/users`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ANON_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    body = await signIn()
  }
  if (!body.accessToken) throw new Error(`拿不到 ${email} 的令牌：${JSON.stringify(body)}`)
  return body.accessToken
}

/** 内省拿 uid（PG 模式清理测试数据用） */
async function uidOf(token) {
  const r = await fetchRetry(`${INSFORGE_URL}/api/auth/sessions/current`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  return (await r.json()).user?.id
}

// ── 控制面：鉴权 + 积分 + 调试后门 + 会话预算 1 积分（⑥ 的引信） ──
const DATABASE_URL = process.env.E2E_DATABASE_URL
const dbDir = mkdtempSync(join(tmpdir(), 'credits-e2e-'))
const srv = spawn('./socket-server/node_modules/.bin/tsx', ['socket-server/src/index.ts'], {
  env: {
    ...process.env,
    SOCKET_PORT: String(PORT),
    ...(DATABASE_URL ? { DATABASE_URL } : { DB_PATH: join(dbDir, 'test.db') }),
    INSFORGE_URL,
    CREDITS_DEBUG: '1',
    SESSION_CREDIT_CAP: '1',
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
log(`控制面就绪（${DATABASE_URL ? 'PostgreSQL' : 'SQLite'}，CREDITS_DEBUG=1，SESSION_CREDIT_CAP=1）`)

const token = await userToken(EMAIL, PASSWORD)
const uid = await uidOf(token)
log(`测试用户 ${EMAIL}（uid ${uid}）`)

const s = io(BASE, { transports: ['websocket'], auth: { token }, reconnection: false })
await new Promise((resolve, reject) => {
  s.on('connect', resolve)
  s.on('connect_error', reject)
})
const emit = (ev, p) => new Promise((r) => s.emit(ev, p, r))

// 事件收集：等某个谓词命中，超时拒掉
const seen = []
s.on('event', ({ event }) => seen.push(event))
const walletUpdates = []
s.on('wallet_update', (w) => walletUpdates.push(w))
function waitEvent(pred, ms, what) {
  const hit = seen.find(pred)
  if (hit) return Promise.resolve(hit)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      // 超时时把见过的事件转储出来 —— 黑盒等死没法排查
      console.error('已见事件:', seen.map((e) => `${e.type}${e.type === 'statusUpdate' ? ':' + e.agentStatus + ':' + (e.brief ?? '') : ''}`).join(' | '))
      reject(new Error(`等不到 ${what}（${ms / 1000}s）`))
    }, ms)
    const onEv = ({ event }) => {
      if (pred(event)) {
        clearTimeout(timer)
        s.off('event', onEv)
        resolve(event)
      }
    }
    s.on('event', onEv)
  })
}

// ── ① 试用积分 ──
const w1 = await emit('get_wallet', {})
check('新用户自动到账 100 试用积分', w1?.balance === TRIAL, `balance=${w1?.balance}`)
check('ledger 记了 trial 入账', w1?.ledger?.some((l) => l.reason === 'trial' && l.delta === TRIAL))

// ── ② 充值包 ──
check('三档充值包就位', w1?.packs?.length === 3, w1?.packs?.map((p) => `${p.key}=$${p.amount}`).join(' '))
check('waffo 通道已配', w1?.waffo === true)

// ── ③ 耗尽硬停止 ──
const drained = await emit('debug_grant', { credits: -(TRIAL + 100) })
check('debug_grant 扣减到账', drained?.balance === -100, `balance=${drained?.balance}`)
const sess = await emit('create_session', {})
await emit('join_session', { sessionId: sess.id })
s.emit('send_message', { sessionId: sess.id, text: '这条不该被投递' })
const blocked = await waitEvent(
  (e) => e.type === 'statusUpdate' && e.code === 'insufficient_credits',
  10_000,
  '积分不足事件',
)
check('余额 ≤0 时发消息被拦（insufficient_credits）', !!blocked)
const w2 = await emit('get_wallet', {})
check('被拦后余额没有变动', w2?.balance === -100, `balance=${w2?.balance}`)

// ── ④ 充值恢复 ──
const granted = await emit('debug_grant', { credits: 500 })
check('debug_grant 入账', granted?.balance === 400, `balance=${granted?.balance}`)
await new Promise((r) => setTimeout(r, 300))
check('wallet_update 推送到达', walletUpdates.some((w) => w.balance === 400))

// ── ⑤ 真任务扣费一致性（⑥ 的预算事件也在这轮之后触发） ──
log('跑真任务（沙箱 + 模型，约 1-2 分钟）…')
s.emit('send_message', { sessionId: sess.id, text: '用 bash 执行 echo credits-ok，然后说 DONE。' })
const usage = await waitEvent((e) => e.type === 'usageReport', 240_000, 'usageReport')
check('usageReport 到达且带积分快照', usage.credits > 0 && usage.costUsd > 0,
  `credits=${usage.credits} cost=$${usage.costUsd?.toFixed(4)} model=${usage.model ?? '?'}`)

// ── ⑥ 会话预算保险丝（cap=1，首轮扣费必触发） ──
// 注意顺序：usageReport 事件是先广播、扣费是异步落的 —— 预算事件（在扣费
// 事务提交之后才发）才是「账已落」的信号，余额断言必须在它之后。
const cap = await waitEvent(
  (e) => e.type === 'statusUpdate' && e.code === 'session_budget_cap',
  30_000,
  '会话预算事件',
)
check('会话预算保险丝触发（session_budget_cap）', !!cap)

const w3 = await emit('get_wallet', {})
check('扣费后余额 = 400 - credits', w3?.balance === 400 - usage.credits,
  `balance=${w3?.balance} 期望 ${400 - usage.credits}`)
const usageEntry = w3?.ledger?.find((l) => l.reason === 'usage')
check('ledger 记了 usage 扣减', usageEntry?.delta === -usage.credits,
  usageEntry ? `delta=${usageEntry.delta}` : '没有 usage 行')

// ── 收尾 ──
s.close()
srv.kill()

// PG 模式：清掉测试用户的账务痕迹（会话连带事件、usage 有外键级联）
if (DATABASE_URL && uid) {
  const { createRequire } = await import('node:module')
  const require = createRequire(new URL('../socket-server/package.json', import.meta.url))
  const pg = require('pg')
  const pool = new pg.Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } })
  try {
    await pool.query('DELETE FROM sessions WHERE user_id = $1', [uid])
    await pool.query('DELETE FROM usage_records WHERE user_id = $1', [uid])
    await pool.query('DELETE FROM credit_ledger WHERE user_id = $1', [uid])
    await pool.query('DELETE FROM orders WHERE user_id = $1', [uid])
    await pool.query('DELETE FROM wallets WHERE user_id = $1', [uid])
    log('PG 测试数据已清理')
  } finally {
    await pool.end()
  }
}

console.log(pass ? '\n全部通过 ✓' : '\n有断言失败 ✗')
process.exit(pass ? 0 : 1)
