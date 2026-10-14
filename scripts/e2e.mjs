/**
 * 端到端验证：不开浏览器，直接以 Socket.IO 客户端的身份走一遍完整链路。
 *
 *   本脚本 → socket-server → agent-runtime → pi → bash
 *          ←              ←                ←
 *
 * 断言的是「右侧终端能拿到真实增量输出」——
 * 即 toolUsed.detail.terminal 的 output 分多次到达，而不是结束时一次性给。
 *
 *   node scripts/e2e.mjs
 */
import { io } from 'socket.io-client'

const URL = process.env.SOCKET_URL ?? 'http://localhost:4000'
const TASK = process.argv[2] ??
  '用 bash 执行这一条命令：for i in 1 2 3 4 5; do echo "tick $i"; sleep 1; done  然后说 DONE。'

const s = io(URL, { transports: ['websocket'] })
const t0 = Date.now()
const termChunks = []
let sessionId

const el = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(5)

s.on('connect', () => {
  console.log(`${el()}s  connected`)
  s.emit('create_session', {}, (sess) => {
    sessionId = sess.id
    console.log(`${el()}s  session ${sessionId}`)
    s.emit('join_session', { sessionId }, () => {
      s.emit('send_message', { sessionId, text: TASK })
      console.log(`${el()}s  → ${TASK.slice(0, 60)}…`)
    })
  })
})

s.on('event', ({ event: e }) => {
  switch (e.type) {
    case 'liveStatus':
      console.log(`${el()}s  · ${e.text}`)
      break
    case 'sandboxUpdate':
      console.log(`${el()}s  □ sandbox=${e.sandboxId} vnc=${e.vncUrl ?? '-'}`)
      break
    case 'statusUpdate':
      console.log(`${el()}s  ${e.agentStatus === 'running' ? '▶' : '■'} ${e.brief ?? e.agentStatus}`)
      if (e.agentStatus === 'stopped') setTimeout(report, 300)
      if (e.agentStatus === 'failed') { console.error('FAILED:', e.description); process.exit(1) }
      break
    case 'chat':
      if (e.sender === 'assistant') {
        console.log(`${el()}s  💬 ${e.content.replace(/\n/g, ' ').slice(0, 70)}`)
      }
      break
    case 'toolUsed': {
      const t = e.detail?.terminal
      if (t) {
        const out = t.output.join('')
        if (out) {
          termChunks.push({ at: (Date.now() - t0) / 1000, text: out })
          console.log(`${el()}s  ▸ [${e.status}] +${JSON.stringify(out.slice(0, 40))}`)
        } else if (t.command) {
          console.log(`${el()}s  ▸ [${e.status}] $ ${t.command}`)
        }
      } else {
        console.log(`${el()}s  ▸ [${e.status}] ${e.message.action} ${e.message.param ?? ''}`)
      }
      break
    }
  }
})

function report() {
  console.log('\n──────── 终端增量 ────────')
  for (const c of termChunks) console.log(`  +${c.at.toFixed(1)}s  ${JSON.stringify(c.text)}`)

  const full = termChunks.map((c) => c.text).join('')
  const ticks = (full.match(/tick \d/g) ?? []).length
  const spread = termChunks.length > 1
    ? termChunks[termChunks.length - 1].at - termChunks[0].at
    : 0

  console.log('\n──────── 断言 ────────')
  const checks = [
    ['终端有输出', full.length > 0],
    ['5 次 tick 全部到达', ticks === 5],
    ['分多次增量到达（非一次性）', termChunks.length >= 3],
    [`增量跨越 ≥3s（真流式，实测 ${spread.toFixed(1)}s）`, spread >= 3],
  ]
  let ok = true
  for (const [name, pass] of checks) {
    console.log(`  ${pass ? '✓' : '✗'} ${name}`)
    if (!pass) ok = false
  }
  console.log(ok ? '\nPASS' : '\nFAIL')
  s.close()
  process.exit(ok ? 0 : 1)
}

setTimeout(() => { console.error('\n超时'); report() }, 120_000)
