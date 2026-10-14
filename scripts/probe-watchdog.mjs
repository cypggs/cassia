// 看门狗/自愈验证：本地起 agent-runtime，pi 记忆数字 → SIGKILL 杀掉 →
// 断言自动重起、接回上下文、广播诚实状态。
//   node --env-file=.env scripts/probe-watchdog.mjs
import { spawn } from 'node:child_process'
import { mkdirSync, realpathSync } from 'node:fs'
import WebSocket from 'ws'

const SID = 'wdprobe1'
const WS_URL = 'ws://localhost:8339/ws'
const WORKSPACE = '/tmp/rt-wd-ws'
mkdirSync(WORKSPACE, { recursive: true })

// 起 runtime（看门狗调到 5s，别等一分钟）
const rt = spawn('./agent-runtime/node_modules/.bin/tsx', ['agent-runtime/src/index.ts'], {
  env: {
    ...process.env,
    PORT: '8339',
    WORKSPACE,
    PI_WATCHDOG_MS: '5000',
    PI_MODEL: 'deepseek/deepseek-flash',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
rt.stdout.on('data', (d) => process.stdout.write(`[rt] ${d}`))
rt.stderr.on('data', (d) => process.stdout.write(`[rt!] ${d}`))
process.on('exit', () => rt.kill())

// 等 healthz
for (let i = 0; i < 60; i++) {
  try { if ((await fetch('http://localhost:8339/healthz')).ok) break } catch {}
  await new Promise((r) => setTimeout(r, 500))
}

const ws = new WebSocket(WS_URL)
await new Promise((r) => ws.on('open', r))
const events = []
const waiters = []
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString())
  if (m.type === 'event') {
    events.push(m.event)
    for (const w of [...waiters]) w(m.event)
  }
})
const waitFor = (pred, ms = 120_000) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('waitFor 超时')), ms)
  waiters.push((e) => { if (pred(e)) { clearTimeout(t); res(e) } })
})
const send = (o) => ws.send(JSON.stringify(o))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

send({ type: 'attach', sessionId: SID, model: 'deepseek/deepseek-flash', env: { DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY } })
await sleep(1000)
send({ type: 'prompt', text: '记住数字 9999。只回复 ok 两个字。' })
await waitFor((e) => e.type === 'statusUpdate' && e.agentStatus !== 'running')
console.log('✓ 第一轮完成')

// 找到 runtime 的 pi 子进程，SIGKILL。
// 进程名不可靠（macOS 上 shim 显示为 node）—— 从 rt.pid 向下递归两级，
// 按 cwd == <WORKSPACE>/<SID> 认，这个全系统唯一。
const { execSync } = await import('node:child_process')
const descendants = [
  ...execSync(`pgrep -P ${rt.pid}`).toString().trim().split('\n'),
  ...execSync(`pgrep -P ${rt.pid}`).toString().trim().split('\n')
    .flatMap((p) => execSync(`pgrep -P ${p} || true`).toString().trim().split('\n')),
].filter(Boolean)
let piPid = ''
// macOS 的 /tmp 是 /private/tmp 的软链，cwd 要按真实路径比
const wantCwd = realpathSync(`${WORKSPACE}/${SID}`)
for (const p of descendants) {
  const d = execSync(`lsof -a -p ${p} -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' || true`).toString().trim()
  if (d === wantCwd) { piPid = p; break }
}
if (!piPid) throw new Error(`没找到 pi 进程（子孙: ${descendants}）`)
console.log('杀掉 pi pid=', piPid)
process.kill(Number(piPid), 'SIGKILL')

// 断言：收到诚实的恢复事件
const revived = await waitFor(
  (e) => e.type === 'statusUpdate' && (e.brief ?? '').includes('自动恢复'),
  60_000,
)
console.log('✓ 恢复事件:', revived.brief, '/', revived.description)

// 断言：上下文还在
send({ type: 'prompt', text: '我刚才让你记的数字是什么？只回答数字。' })
await waitFor((e) => e.type === 'statusUpdate' && e.agentStatus === 'stopped' && !(e.brief ?? '').includes('异常'), 120_000).catch(() => {})
await sleep(1000)
const chats = events.filter((e) => e.type === 'chat' && e.sender === 'assistant').map((e) => e.content)
const last = chats[chats.length - 1] ?? ''
console.log(last.includes('9999') ? `✓ 上下文接回来了: ${last.slice(0, 60)}` : `✗ 上下文丢失: ${last.slice(0, 120)}`)

ws.close()
rt.kill()
process.exit(last.includes('9999') ? 0 : 1)
