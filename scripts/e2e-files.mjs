/**
 * 文件面板数据验证：Agent 新建/编辑文件时，事件流里必须带
 * 结构化的 textEditor detail（路径 + 内容），前端文件面板全靠它渲染。
 *
 * 注意这个测试跑的是**模板里烤进去的 runtime** —— translate.ts 的改动
 * 必须重新构建模板后才会生效。本机模式（AGENT_RUNTIME_URL）则直接生效。
 *
 *   node scripts/e2e-files.mjs
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

const editorEvents = []
let done
const finished = new Promise((r) => (done = r))

s.on('event', ({ event: e }) => {
  if (e.type === 'toolUsed' && e.detail?.textEditor) {
    editorEvents.push(e)
    const d = e.detail.textEditor
    log(`▸ ${e.status} ${d.action} ${d.path}` +
      (d.content ? ` (${d.content.length} 字符)` : ''))
  }
  if (e.type === 'statusUpdate' && e.agentStatus !== 'running') setTimeout(done, 800)
})

s.emit('send_message', {
  sessionId: sess.id,
  text: '做两步，别多做：1) 创建文件 notes.txt，写入两行：alpha 和 beta。' +
        '2) 用 edit 工具把 alpha 改成 ALPHA。完成后说完成。',
})

await Promise.race([finished, new Promise((r) => setTimeout(r, 180_000))])
s.close()

const creates = editorEvents.filter((e) => e.detail.textEditor.action === 'create')
const edits = editorEvents.filter((e) => e.detail.textEditor.action === 'edit')
const createWithContent = creates.find((e) => e.detail.textEditor.content?.includes('alpha'))
const editWithBoth = edits.find(
  (e) => e.detail.textEditor.oldContent?.includes('alpha') &&
         e.detail.textEditor.content?.includes('ALPHA'),
)

console.log('\n──────── 断言 ────────')
const checks = [
  ['有 create 事件且带写入的内容', !!createWithContent],
  ['有 edit 事件且 old/new 都带', !!editWithBoth],
  ['路径正确（notes.txt）', editorEvents.some((e) => e.detail.textEditor.path.endsWith('notes.txt'))],
]
let ok = true
for (const [name, pass] of checks) {
  if (!pass) ok = false
  console.log(`  ${pass ? '✓' : '✗'} ${name}`)
}
if (!ok) {
  console.log('\n收到的 textEditor 事件：')
  for (const e of editorEvents) console.log(' ', JSON.stringify(e.detail.textEditor).slice(0, 200))
}
console.log(ok ? '\nPASS —— 文件面板的数据通路完整' : '\nFAIL')
process.exit(ok ? 0 : 1)
