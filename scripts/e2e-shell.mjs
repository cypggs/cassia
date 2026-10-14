/**
 * 持久 shell 验证：pi 扩展把 bash 落到常驻 PTY 上之后，
 * 第一次调用里的 export / cd 必须在第二次调用里还活着。
 *
 * 这是「具名持久 shell」的核心断言 —— 没有扩展时，pi 每次全新 shell，
 * mark 一定是空的。
 *
 *   node scripts/e2e-shell.mjs
 */
import { io } from 'socket.io-client'

const URL = process.env.SOCKET_URL ?? 'http://localhost:4000'

const t0 = Date.now()
const el = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`.padStart(6)
const log = (...a) => console.log(el(), ...a)

const s = io(URL, { transports: ['websocket'] })
await new Promise((r) => s.on('connect', r))
const sess = await new Promise((r) => s.emit('create_session', {}, r))
await new Promise((r) => s.emit('join_session', { sessionId: sess.id }, r))
log(`会话 ${sess.id}`)

/** actionId → {command, output}，终端事件是 upsert 的，要按 actionId 归并 */
const calls = new Map()
let done
const finished = new Promise((r) => (done = r))

s.on('event', ({ event: e }) => {
  if (e.type === 'toolUsed' && e.detail?.terminal) {
    const t = e.detail.terminal
    const c = calls.get(e.actionId) ?? { command: t.command, output: '' }
    c.output = t.outputType === 'replace' ? t.output.join('') : c.output + t.output.join('')
    calls.set(e.actionId, c)
  }
  if (e.type === 'statusUpdate' && e.agentStatus !== 'running') setTimeout(done, 800)
})

s.emit('send_message', {
  sessionId: sess.id,
  text: '严格分两次 bash 工具调用，别合并：' +
        '第一次执行 export SHMARK=shellpersist42 && mkdir -p /tmp/shprobe && cd /tmp/shprobe && echo first-ok；' +
        '第二次执行 echo "mark=$SHMARK dir=$PWD"。完成后说完成。',
})

await Promise.race([finished, new Promise((r) => setTimeout(r, 180_000))])
s.close()

const outputs = [...calls.values()]
log(`共 ${calls.size} 次 bash 调用`)
const all = outputs.map((c) => c.output).join('\n')

console.log('\n──────── 断言 ────────')
const checks = [
  ['至少两次 bash 调用', calls.size >= 2],
  ['export 跨调用存活（mark=shellpersist42）', all.includes('mark=shellpersist42')],
  ['cd 跨调用存活（dir=/tmp/shprobe）', all.includes('dir=/tmp/shprobe')],
  ['输出无提示符污染', !/bash-[\d.]+[\$#]/.test(all) && !all.includes('\x1b[?2004')],
]
let ok = true
for (const [name, pass] of checks) {
  if (!pass) ok = false
  console.log(`  ${pass ? '✓' : '✗'} ${name}`)
}
if (!ok) {
  console.log('\n各次调用输出：')
  for (const c of outputs) console.log(' $', c.command, '\n  →', JSON.stringify(c.output).slice(0, 300))
}
console.log(ok ? '\nPASS —— shell 状态跨调用存活' : '\nFAIL')
process.exit(ok ? 0 : 1)
