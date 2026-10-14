// plan 面板探针：本地起 agent-runtime（带 plan 扩展），给一个多步任务，
// 断言 planUpdate 全量快照到达、状态有 doing 迁移、newPlanStep 发出、
// 且 plan 工具不在工具时间线留痕。
//   node --env-file=.env scripts/probe-plan.mjs
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import WebSocket from 'ws'

const SID = 'planprobe1'
const PORT = 8341
const WORKSPACE = '/tmp/rt-plan-ws'
mkdirSync(WORKSPACE, { recursive: true })

const rt = spawn('./agent-runtime/node_modules/.bin/tsx', ['agent-runtime/src/index.ts'], {
  env: { ...process.env, PORT: String(PORT), WORKSPACE, PI_MODEL: 'deepseek/deepseek-flash' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
rt.stderr.on('data', (d) => process.stdout.write(`[rt!] ${d}`))
process.on('exit', () => rt.kill())

for (let i = 0; i < 60; i++) {
  try { if ((await fetch(`http://localhost:${PORT}/healthz`)).ok) break } catch {}
  await new Promise((r) => setTimeout(r, 500))
}

const ws = new WebSocket(`ws://localhost:${PORT}/ws`)
await new Promise((r) => ws.on('open', r))
const events = []
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString())
  if (m.type === 'event') events.push(m.event)
})
const send = (o) => ws.send(JSON.stringify(o))

send({ type: 'attach', sessionId: SID, model: 'deepseek/deepseek-flash', env: { DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY } })
await new Promise((r) => setTimeout(r, 1000))

send({
  type: 'prompt',
  text:
    '这是一个多步任务，请严格执行：1) 用 bash 创建文件 plan-test.txt 内容为 pizza-42；' +
    '2) 用 read 读取它确认；3) 把内容告诉我。先建计划再执行，每步完成都更新计划。',
})

// 等任务收尾（最多 3 分钟）
const deadline = Date.now() + 180_000
while (Date.now() < deadline) {
  if (events.some((e) => e.type === 'statusUpdate' && e.agentStatus === 'stopped')) break
  await new Promise((r) => setTimeout(r, 1000))
}

let pass = true
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`)
  if (!ok) pass = false
}

const plans = events.filter((e) => e.type === 'planUpdate')
const steps = events.filter((e) => e.type === 'newPlanStep')
// brief 里有 'plan' 是误报（plan-test.txt 的命令也含）—— 要查的是工具名本身
const planInTools = events.filter((e) => e.type === 'toolUsed' && e.message?.action === 'plan')

check('收到 planUpdate 快照', plans.length > 0, `${plans.length} 份`)
const first = plans[0]
check('快照是全量步骤列表（≥3 步）', (first?.tasks.length ?? 0) >= 3, first?.tasks.map((t) => `${t.title}[${t.status}]`).join(' / '))
check('有 doing 状态迁移', plans.some((p) => p.tasks.some((t) => t.status === 'doing')))
check('有 done 状态迁移', plans.some((p) => p.tasks.some((t) => t.status === 'done')))
check('发出 newPlanStep', steps.length > 0, steps.map((s) => s.title).join(' → '))
check('plan 不在工具时间线留痕', planInTools.length === 0)
const doing = plans.flatMap((p) => p.tasks.filter((t) => t.status === 'doing'))
check('后续事件带 planStepId 回指', events.some((e) => e.type === 'toolUsed' && e.planStepId), doing[0]?.title ?? '')

// 任务本身也得真干了
const chats = events.filter((e) => e.type === 'chat' && e.sender === 'assistant').map((e) => e.content)
check('任务真的完成了（提到 pizza-42）', chats.some((c) => c.includes('pizza-42')))

ws.close()
rt.kill()
console.log(pass ? '\nPASS' : '\nFAIL')
process.exit(pass ? 0 : 1)
