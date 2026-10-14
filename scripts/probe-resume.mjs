/**
 * 暂停/唤醒 × 持久 shell 的隔离探针 —— 不经过 socket-server，直连 runtime。
 *
 * 怀疑：E2B 内存快照恢复后，pi 扩展里 node-pty 的 PTY 已经死掉，
 * 之后的 bash 全挂起（dormancy e2e 的「唤醒后 Agent 无响应」）。
 *
 * 流程：起沙箱 → bash 一条（让 PTY 存在）→ pause → connect 恢复 →
 *       再 bash 一条，60s 内完不成就算复现。
 *   node --env-file=.env scripts/probe-resume.mjs
 */
import { Sandbox } from 'e2b'
import WebSocket from 'ws'

const t0 = Date.now()
const el = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`.padStart(6)
const log = (...a) => console.log(el(), ...a)

const SESSION = 'probe-resume-1'
const env = {}
for (const k of ['DEEPSEEK_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'MOONSHOT_API_KEY'])
  if (process.env[k]) env[k] = process.env[k]

function talk(wsUrl, text, timeoutMs = 90_000) {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl)
    const tools = []
    let settled = false
    const finish = (ok) => { if (!settled) { settled = true; clearTimeout(timer); ws.close(); resolve({ ok, tools }) } }
    const timer = setTimeout(() => finish(false), timeoutMs)
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'attach', sessionId: SESSION, env }))
      setTimeout(() => ws.send(JSON.stringify({ type: 'prompt', text })), 500)
    })
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString())
      const e = msg.event
      if (!e) return
      if (e.type === 'toolUsed' && e.status !== 'running') {
        tools.push({ status: e.status, output: (e.detail?.terminal?.output ?? []).join('').slice(-80) })
      }
      if (e.type === 'statusUpdate' && e.agentStatus !== 'running') setTimeout(() => finish(true), 500)
    })
    ws.on('error', () => finish(false))
  })
}

const sbx = await Sandbox.create(process.env.E2B_TEMPLATE ?? 'cassia-lite', {
  timeoutMs: 600_000,
  envs: { PI_MODEL: 'deepseek/deepseek-flash' },
})
log(`沙箱 ${sbx.sandboxId}`)
const host = sbx.getHost(8330)
for (let i = 0; i < 45; i++) {
  try { if ((await fetch(`https://${host}/healthz`)).ok) break } catch {}
  await new Promise((r) => setTimeout(r, 1000))
}
log('runtime 健康')

const wsUrl = `wss://${host}/ws`
const r1 = await talk(wsUrl, '用 bash 执行：echo before-pause-ok。然后回复 DONE。')
log(`暂停前 bash: ok=${r1.ok}`, JSON.stringify(r1.tools))

log('pause…')
await sbx.pause()
log('已暂停，connect 恢复…')
const sbx2 = await Sandbox.connect(sbx.sandboxId, { timeoutMs: 600_000 })
log('已恢复')
for (let i = 0; i < 45; i++) {
  try { if ((await fetch(`https://${host}/healthz`)).ok) break } catch {}
  await new Promise((r) => setTimeout(r, 1000))
}
log('runtime 恢复健康')

const r2 = await talk(wsUrl, '用 bash 执行：echo after-resume-ok。然后回复 DONE。', 60_000)
log(`唤醒后 bash: ok=${r2.ok}`, JSON.stringify(r2.tools))

if (!r2.ok) {
  log('── 复现。查现场：')
  const r = await sbx2.commands.run(
    'ps aux | grep -E "pi|bash" | grep -v grep; echo ──; tail -5 /home/user/agent-runtime.log 2>/dev/null || tail -5 /home/user/.supervisor/agent-runtime.log',
    { timeoutMs: 15000 },
  ).catch((e) => ({ stdout: '', stderr: String(e.result?.stderr ?? e.message) }))
  console.log(r.stdout, r.stderr)
}

console.log(r2.ok && r2.tools.length > 0 ? '\nPASS —— 唤醒后持久 shell 还能用' : '\nFAIL —— 唤醒后 bash 挂起')
await Sandbox.kill(sbx.sandboxId).catch(() => {})
process.exit(r2.ok ? 0 : 1)
