/**
 * 会话隔离验证：两个会话并发跑不同任务，各自只应看到自己的事件。
 *
 * 这条以前是坏的 —— agent-runtime 曾经是单例（一个 pi 进程 + 广播给所有
 * WS 客户端），本机模式下两个会话会互相串台，而且共享同一份对话上下文。
 *
 *   node scripts/e2e-isolation.mjs
 */
import { io } from 'socket.io-client'

const URL = process.env.SOCKET_URL ?? 'http://localhost:4000'

const CASES = [
  { tag: 'A', marker: 'ALPHA', prompt: '用 bash 执行：echo ALPHA-ALPHA-ALPHA。然后说完成。' },
  { tag: 'B', marker: 'BRAVO', prompt: '用 bash 执行：echo BRAVO-BRAVO-BRAVO。然后说完成。' },
]

const t0 = Date.now()
const el = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(5)

async function run({ tag, marker, prompt }) {
  const s = io(URL, { transports: ['websocket'] })
  const seen = []
  let done

  const finished = new Promise((res) => (done = res))

  await new Promise((res) => s.on('connect', res))
  const sess = await new Promise((res) => s.emit('create_session', {}, res))
  await new Promise((res) => s.emit('join_session', { sessionId: sess.id }, res))

  s.on('event', ({ event: e }) => {
    if (e.type === 'toolUsed' && e.detail?.terminal) {
      const out = e.detail.terminal.output.join('')
      if (out.trim()) seen.push(out)
    }
    if (e.type === 'chat' && e.sender === 'assistant') seen.push(e.content)
    if (e.type === 'statusUpdate' && e.agentStatus !== 'running') setTimeout(done, 500)
    if (e.type === 'statusUpdate' && e.agentStatus === 'failed') {
      console.error(`[${tag}] FAILED: ${e.description}`)
    }
  })

  console.log(`${el()}s  [${tag}] session ${sess.id}`)
  s.emit('send_message', { sessionId: sess.id, text: prompt })

  await Promise.race([finished, new Promise((r) => setTimeout(r, 90_000))])
  s.close()

  const text = seen.join('\n')
  const other = CASES.find((c) => c.tag !== tag).marker
  return { tag, marker, other, hasOwn: text.includes(marker), hasOther: text.includes(other), text }
}

const results = await Promise.all(CASES.map(run))

console.log('\n──────── 断言 ────────')
let ok = true
for (const r of results) {
  const pass = r.hasOwn && !r.hasOther
  if (!pass) ok = false
  console.log(`  ${pass ? '✓' : '✗'} 会话 ${r.tag}: 看到自己的 ${r.marker}=${r.hasOwn}，` +
    `看到别人的 ${r.other}=${r.hasOther}`)
  if (!pass) console.log(`      收到的内容:\n${r.text.split('\n').map((l) => '      | ' + l).join('\n')}`)
}
console.log(ok ? '\nPASS —— 会话之间互不串台' : '\nFAIL —— 事件跨会话泄漏')
process.exit(ok ? 0 : 1)
