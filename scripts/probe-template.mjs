/**
 * 模板冒烟测试：起一个沙箱，确认 agent-runtime 自启、端口转发可达、
 * pi 能被 spawn 起来并真的产生事件。
 *
 * 这一步刻意不经过控制面 —— 直连沙箱的 WebSocket，
 * 把「模板本身有没有问题」和「控制面有没有问题」分开。
 *
 *   node --env-file=../.env scripts/probe-template.mjs
 */
import { Sandbox } from 'e2b'
import WebSocket from 'ws'

const TEMPLATE = process.env.E2B_TEMPLATE ?? 'cassia-lite'
const MODEL = process.env.PI_MODEL ?? 'deepseek/deepseek-flash'

const t0 = Date.now()
const el = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`.padStart(7)
const log = (...a) => console.log(el(), ...a)

let sbx
try {
  sbx = await Sandbox.create(TEMPLATE, { timeoutMs: 300_000 })
  log(`沙箱已创建 ${sbx.sandboxId}`)

  const host = sbx.getHost(8330)
  const healthUrl = `https://${host}/healthz`
  log(`健康检查 ${healthUrl}`)

  let health
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(healthUrl)
      if (r.ok) { health = await r.json(); break }
    } catch { /* 冷启动期间连不上是正常的 */ }
    await new Promise((r) => setTimeout(r, 1000))
  }
  if (!health) throw new Error('agent-runtime 60 秒内没起来')
  log('runtime 就绪', JSON.stringify(health))

  // ── 直连 runtime 的 WebSocket，走一次完整的 attach → prompt → 事件
  const ws = new WebSocket(`wss://${host}/ws`)
  const events = []
  let terminalChunks = 0
  let done
  const finished = new Promise((r) => (done = r))

  ws.on('open', () => {
    log('WS 已连接，attach')
    ws.send(JSON.stringify({
      type: 'attach',
      sessionId: 'probe',
      model: MODEL,
      // 密钥走 attach 下发，镜像里没有
      env: { DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ?? '' },
    }))
    ws.send(JSON.stringify({
      type: 'prompt',
      text: '用 bash 执行：for i in 1 2 3; do echo "tick-$i"; sleep 1; done。执行完说一句完成。',
    }))
  })

  ws.on('message', (raw) => {
    const { event: e } = JSON.parse(raw.toString())
    if (!e) return
    events.push(e)
    if (e.type === 'toolUsed' && e.detail?.terminal?.output?.join('').trim()) {
      terminalChunks++
      log(`终端输出 #${terminalChunks}`, JSON.stringify(e.detail.terminal.output.join('')))
    }
    if (e.type === 'chat' && e.sender === 'assistant') log('回复', e.content.slice(0, 80))
    if (e.type === 'statusUpdate') {
      log(`状态 ${e.agentStatus} ${e.brief ?? ''}`)
      if (e.agentStatus !== 'running') setTimeout(done, 800)
    }
  })
  ws.on('error', (e) => log('WS 错误', e.message))

  await Promise.race([finished, new Promise((r) => setTimeout(r, 120_000))])
  ws.close()

  console.log('\n──────── 断言 ────────')
  const checks = [
    ['runtime 自启并可达', !!health?.ok],
    ['pi 被 spawn 并产生事件', events.length > 0],
    ['终端输出分多次到达（真流式）', terminalChunks >= 2],
    ['助手给出了回复', events.some((e) => e.type === 'chat' && e.sender === 'assistant')],
  ]
  let ok = true
  for (const [name, pass] of checks) {
    if (!pass) ok = false
    console.log(`  ${pass ? '✓' : '✗'} ${name}`)
  }
  console.log(ok ? '\nPASS' : '\nFAIL')
  process.exitCode = ok ? 0 : 1
} finally {
  if (sbx) {
    await sbx.kill().catch(() => {})
    log('沙箱已销毁')
  }
}
