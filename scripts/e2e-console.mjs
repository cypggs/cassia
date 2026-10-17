/**
 * Console（用户独立 shell）e2e：直接驱动 Socket.IO 的 console_* 协议，
 * 验证沙箱里 node-pty 的真交互能力。覆盖：
 *   ① console_start ack + bash 提示符到达
 *   ② cwd 是会话工作区（与 Agent 同目录、文件互通的证据：pwd 以会话 id 结尾）
 *   ③ console_resize 生效：stty size 行列跟着变
 *   ④ Ctrl-C（\x03）真能打断前台命令：sleep 100 中断后 $? = 130
 *   ⑤ 交互程序 stdin：cat 回显键入内容
 *   ⑥ exit → console_exited(code=0)，再 start 幂等可重开
 *   ⑦ 会话隔离：A 的输出不串到 B，A 的工作区文件 B 看不到
 *
 * 前置：本机三进程在跑（web 不需要，socket :4000 + runtime :8330）：
 *   pnpm dev:socket   （另一个终端 pnpm dev:runtime）
 *
 *   node scripts/e2e-console.mjs
 */
import { io } from 'socket.io-client'

const URL = process.env.SOCKET_URL ?? 'http://localhost:4000'
const t0 = Date.now()
const el = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`.padStart(6)
const log = (...a) => console.log(el(), ...a)
let pass = true
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`)
  if (!ok) pass = false
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 包装一个会话的 console 连接：start/输入/收输出 */
function makeConsole(tag) {
  const s = io(URL, { transports: ['websocket'] })
  const buf = []
  let exitCode = null
  s.on('console_data', ({ sessionId: sid, data }) => {
    if (sid === s.sessionId) buf.push(data)
  })
  s.on('console_exited', ({ sessionId: sid, code }) => {
    if (sid === s.sessionId) exitCode = code
  })
  const text = () => buf.join('')
  const emitP = (ev, p) => new Promise((r) => s.emit(ev, p, r))
  async function open() {
    await new Promise((res) => s.on('connect', res))
    const sess = await emitP('create_session', {})
    s.sessionId = sess.id
    await emitP('join_session', { sessionId: sess.id })
    return sess.id
  }
  async function start(cols = 80, rows = 24) {
    const r = await emitP('console_start', { sessionId: s.sessionId, cols, rows })
    return r?.ok === true
  }
  const input = (data) => s.emit('console_input', { sessionId: s.sessionId, data })
  const resize = (cols, rows) => s.emit('console_resize', { sessionId: s.sessionId, cols, rows })
  const close = () => s.emit('console_close', { sessionId: s.sessionId })
  /** 轮询直到输出包含 substr 或超时 */
  async function waitFor(substr, timeout = 20_000) {
    const until = Date.now() + timeout
    while (Date.now() < until) {
      if (text().includes(substr)) return true
      await sleep(200)
    }
    return false
  }
  return { s, open, start, input, resize, close, text, waitFor, get exitCode() { return exitCode }, clear: () => (buf.length = 0) }
}

// ── ① start + 提示符 ──────────────────────────────────────────────
const A = makeConsole('A')
const sidA = await A.open()
log(`会话 A ${sidA}`)
check('console_start ack ok', await A.start())

// bash 起好后会打提示符（cwd 尾部 + $）；等它出现证明 PTY 活了
const promptReady = await A.waitFor('$', 15_000)
check('bash 提示符到达', promptReady)
if (!promptReady) { console.log('A 收到的内容:', JSON.stringify(A.text())); process.exit(1) }

// ── ② cwd = 会话工作区 ────────────────────────────────────────────
A.clear()
A.input('echo PWD=$(pwd) MARKER\n')
check('pwd 以会话 id 结尾（cwd 隔离且与 Agent 同工作区）',
  await A.waitFor(`PWD=`, 10_000) && A.text().includes(`PWD=`) && A.text().includes(sidA),
  A.text().split('\r\n').find((l) => l.includes('PWD=')) ?? '')

// ── ③ resize 生效 ─────────────────────────────────────────────────
A.clear()
A.resize(100, 31)
await sleep(400) // resize 消息先到 PTY，再发 stty 才量的是新尺寸
A.input('stty size\n')
const sttyOk = await A.waitFor('31 100', 10_000)
check('console_resize 生效（stty size = 31 100）', sttyOk, A.text().trim().split('\r\n').pop() ?? '')

// ── ④ Ctrl-C 打断前台命令 ─────────────────────────────────────────
A.clear()
A.input('sleep 100\n')
await sleep(800)
A.input('\x03') // Ctrl-C
await sleep(800)
A.input('echo CC_RC=$?\n')
const ccOk = await A.waitFor('CC_RC=130', 10_000)
check('Ctrl-C 打断 sleep（$? = 130）', ccOk, A.text().split('\r\n').find((l) => l.includes('CC_RC=')) ?? '')

// ── ⑤ 交互程序 stdin（cat 回显）────────────────────────────────────
A.clear()
A.input('cat\n')
await sleep(600)
A.input('hello-console-stdin\n')
const catOk = await A.waitFor('hello-console-stdin', 10_000)
A.input('\x04') // Ctrl-D 结束 cat
check('交互程序 stdin 透传（cat 回显键入）', catOk)

// ── ⑥ exit → console_exited，可重开 ───────────────────────────────
A.clear()
A.input('exit\n')
let exited = false
for (let i = 0; i < 50 && A.exitCode === null; i++) await sleep(200)
exited = A.exitCode !== null
check('exit 收到 console_exited', exited, `code=${A.exitCode}`)
check('console_start 幂等重开', await A.start(100, 31))
check('重开后 shell 可用', await (A.clear(), A.input('echo REBACK=$((6*7))\n'), A.waitFor('REBACK=42', 10_000)))

// ── ⑦ 会话隔离：B 看不到 A 的输出和文件 ────────────────────────────
const B = makeConsole('B')
const sidB = await B.open()
log(`会话 B ${sidB}`)
await B.start(80, 24)
await B.waitFor('$', 15_000)
const secret = `A-SECRET-${Date.now()}`
A.clear()
A.input(`echo ${secret}\n`)
await A.waitFor(secret, 10_000)
await sleep(1000)
check('A 的 console 输出不串到 B', !B.text().includes(secret))
A.clear()
A.input('touch console_marker_a\n')
await A.waitFor('$ ', 10_000)
await sleep(500)
B.clear()
B.input('ls console_marker_a\n')
const leakOk = await B.waitFor('No such file', 10_000)
check('A 的工作区文件 B 不可见（各自独立 cwd）', leakOk, B.text().split('\r\n').find((l) => l.includes('console_marker')) ?? '')

A.close()
B.close()
A.s.close()
B.s.close()

console.log(pass ? '\nPASS —— Console 全链路可用' : '\nFAIL')
process.exit(pass ? 0 : 1)
