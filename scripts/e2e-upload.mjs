/**
 * 附件通道 e2e：上传 → Agent 在沙箱里读得到 → 列表 → 下载字节一致 → 安全守卫。
 *
 * 打运行中的 socket-server（默认 :4000）：
 *   node scripts/e2e-upload.mjs
 */
import { io } from 'socket.io-client'

const URL = process.env.SOCKET_URL ?? 'http://localhost:4000'

const t0 = Date.now()
const el = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`.padStart(6)
const log = (...a) => console.log(el(), ...a)
let pass = true
const check = (name, ok) => { console.log(`  ${ok ? '✓' : '✗'} ${name}`); if (!ok) pass = false }

const MARKER = `upload-e2e-${Date.now()}`
const FILENAME = `测试附件-${Date.now()}.txt` // 顺便验证非 ASCII 文件名

const s = io(URL, { transports: ['websocket'] })
await new Promise((r) => s.on('connect', r))
const sess = await new Promise((r) => s.emit('create_session', {}, r))
await new Promise((r) => s.emit('join_session', { sessionId: sess.id }, r))
log(`会话 ${sess.id}`)

// ── 1. 上传 ──
const up = await fetch(`${URL}/sessions/${sess.id}/files?name=${encodeURIComponent(FILENAME)}`, {
  method: 'POST',
  body: `第一行 ${MARKER}\n第二行 结束\n`,
})
const upBody = await up.json()
check('上传成功', up.status === 200 && upBody.path === `uploads/${FILENAME}`)
log(`已上传 ${upBody.path}（${upBody.size}B，含 provision 等待）`)

// ── 2. Agent 能读到（证明文件真到了沙箱的会话目录）──
const events = []
let done
const finished = new Promise((r) => (done = r))
s.on('event', ({ event: e }) => {
  events.push(e)
  if (e.type === 'statusUpdate' && e.agentStatus !== 'running') setTimeout(done, 800)
})
s.emit('send_message', {
  sessionId: sess.id,
  text: `读 uploads/${FILENAME}，把内容原样复述给我，不要改动。`,
  attachments: [{ name: upBody.name, path: upBody.path, size: upBody.size }],
})
await Promise.race([finished, new Promise((r) => setTimeout(r, 240_000))])

const chats = events.filter((e) => e.type === 'chat' && e.sender === 'assistant').map((e) => e.content)
const termOut = events
  .filter((e) => e.type === 'toolUsed' && e.detail?.terminal)
  .map((e) => e.detail.terminal.output.join(''))
check('Agent 复述出了文件内容', chats.some((c) => c.includes(MARKER)) || termOut.some((o) => o.includes(MARKER)))
check('用户气泡带了附件元数据', events.some((e) => e.type === 'chat' && e.sender === 'user' && e.attachments?.length === 1))

// ── 3. 列表 ──
const list = await (await fetch(`${URL}/sessions/${sess.id}/files`)).json()
check('工作区列表里有上传的文件', list.files?.some((f) => f.path === upBody.path && f.size === upBody.size))

// ── 4. 下载字节一致 ──
const dl = await fetch(`${URL}/sessions/${sess.id}/file?path=${encodeURIComponent(upBody.path)}`)
const dlText = await dl.text()
check('下载字节与上传一致', dl.status === 200 && dlText.includes(MARKER))
check('下载带 attachment 头', (dl.headers.get('content-disposition') ?? '').includes('attachment'))

// ── 5. 安全守卫 ──
const evil = await fetch(`${URL}/sessions/${sess.id}/file?path=${encodeURIComponent('../../etc/passwd')}`)
check('路径穿越被拒（400）', evil.status === 400)
const noSess = await fetch(`${URL}/sessions/not-exist/files`, { method: 'POST', body: 'x' })
check('不存在的会话 404', noSess.status === 404)

s.close()
console.log(pass ? '\nPASS' : '\nFAIL')
process.exit(pass ? 0 : 1)
