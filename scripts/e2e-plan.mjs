/**
 * plan 面板 e2e：通过运行中的 socket-server（默认 :4000）发多步任务，
 * 断言计划快照到达、状态迁移、newPlanStep、planStepId 回指、
 * plan 工具不在工具时间线留痕。
 *
 * 注意：跑的是模板里烤进去的 runtime —— translate.ts / pi-extension 的
 * 改动必须重建模板后才生效。
 *
 *   node scripts/e2e-plan.mjs
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

const s = io(URL, { transports: ['websocket'] })
await new Promise((r) => s.on('connect', r))
const sess = await new Promise((r) => s.emit('create_session', {}, r))
await new Promise((r) => s.emit('join_session', { sessionId: sess.id }, r))
log(`会话 ${sess.id}`)

const events = []
let done
const finished = new Promise((r) => (done = r))
s.on('event', ({ event: e }) => {
  events.push(e)
  if (e.type === 'statusUpdate' && e.agentStatus !== 'running') setTimeout(done, 800)
})

s.emit('send_message', {
  sessionId: sess.id,
  text:
    '这是一个多步任务，请严格执行：1) 用 bash 创建文件 plan-e2e.txt 内容为 sushi-77；' +
    '2) 用 read 读取它确认；3) 把内容告诉我。先建计划再执行，每步完成都更新计划。',
})
await Promise.race([finished, new Promise((r) => setTimeout(r, 300_000))])

const plans = events.filter((e) => e.type === 'planUpdate')
const steps = events.filter((e) => e.type === 'newPlanStep')
const planInTools = events.filter((e) => e.type === 'toolUsed' && e.message?.action === 'plan')

check('收到 planUpdate 快照', plans.length > 0, `${plans.length} 份`)
const first = plans[0]
check('快照是全量步骤列表（≥3 步）', (first?.tasks.length ?? 0) >= 3,
  first?.tasks.map((t) => `${t.title}[${t.status}]`).join(' / '))
check('有 doing 状态迁移', plans.some((p) => p.tasks.some((t) => t.status === 'doing')))
check('有 done 状态迁移', plans.some((p) => p.tasks.some((t) => t.status === 'done')))
check('发出 newPlanStep', steps.length > 0, steps.map((x) => x.title).join(' → '))
check('plan 不在工具时间线留痕', planInTools.length === 0)
check('后续事件带 planStepId 回指', events.some((e) => e.type === 'toolUsed' && e.planStepId))

const chats = events.filter((e) => e.type === 'chat' && e.sender === 'assistant').map((e) => e.content)
check('任务真的完成了（提到 sushi-77）', chats.some((c) => c.includes('sushi-77')))

s.close()
console.log(pass ? '\nPASS' : '\nFAIL')
process.exit(pass ? 0 : 1)
