/**
 * cassia 画面通道验证。
 *
 * 「端口是通的」不算数 —— 那只证明 websockify 在监听。这里查三层：
 *
 *   1. 协议层：WebSocket 连上去要收到 VNC 的握手串 "RFB 003.00x"。
 *   2. 桌面层：X 上那个 Chromium 窗口的标题，要跟 Agent 刚打开的页面对上。
 *      这证明「Agent 操作的浏览器」和「用户看到的浏览器」是同一个 ——
 *      如果 Agent 偷偷开了 headless，标题不会变。
 *   3. 像素层：抓一张 X 的截图，确认不是纯色（黑屏 / 白屏都是纯色）。
 *
 *   node --env-file=.env scripts/probe-screen.mjs
 */
import { Sandbox } from 'e2b'
import WebSocket from 'ws'

const TEMPLATE = process.env.E2B_TEMPLATE_SCREEN ?? 'cassia'
const MODEL = process.env.PI_MODEL ?? 'deepseek/deepseek-flash'
const TARGET = 'https://example.com/'

const t0 = Date.now()
const el = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`.padStart(7)
const log = (...a) => console.log(el(), ...a)

let sbx
const results = {}

try {
  sbx = await Sandbox.create(TEMPLATE, { timeoutMs: 600_000 })
  log(`沙箱已创建 ${sbx.sandboxId}`)

  // ── runtime 就绪
  const rtHost = sbx.getHost(8330)
  for (let i = 0; i < 90; i++) {
    try {
      const r = await fetch(`https://${rtHost}/healthz`)
      if (r.ok) { results.runtime = true; break }
    } catch { /* 冷启动 */ }
    await new Promise((r) => setTimeout(r, 1000))
  }
  log(`runtime 就绪=${!!results.runtime}`)

  // ── 1. 协议层：VNC 握手
  const vncHost = sbx.getHost(5901)
  log(`VNC 握手 wss://${vncHost}/websockify`)
  results.rfbHandshake = await new Promise((resolve) => {
    const ws = new WebSocket(`wss://${vncHost}/websockify`, ['binary'])
    const t = setTimeout(() => { ws.close(); resolve(false) }, 20_000)
    ws.on('message', (d) => {
      const s = Buffer.from(d).toString('latin1')
      clearTimeout(t)
      ws.close()
      log(`VNC 服务端问候: ${JSON.stringify(s.trim())}`)
      resolve(/^RFB 00\d\.00\d/.test(s))
    })
    ws.on('error', (e) => { clearTimeout(t); log('VNC 连接错误', e.message); resolve(false) })
  })

  // ── 让 Agent 去开一个页面
  const ws = new WebSocket(`wss://${rtHost}/ws`)
  let done
  const finished = new Promise((r) => (done = r))
  const chat = []

  ws.on('open', () => {
    ws.send(JSON.stringify({
      type: 'attach',
      sessionId: 'screen-probe',
      model: MODEL,
      env: { DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ?? '' },
    }))
    ws.send(JSON.stringify({
      type: 'prompt',
      text: `用桌面上那个常驻的 Chromium（CDP 9222）打开 ${TARGET}，` +
            `等页面加载完，把 <h1> 的文字打印出来。完成后说 DONE。`,
    }))
  })
  ws.on('message', (raw) => {
    const { event: e } = JSON.parse(raw.toString())
    if (!e) return
    if (e.type === 'toolUsed' && e.message?.action) {
      log(`▸ ${e.status} ${e.message.action} ${(e.message.param ?? '').slice(0, 70)}`)
    }
    if (e.type === 'chat' && e.sender === 'assistant') chat[0] = e.content
    if (e.type === 'statusUpdate' && e.agentStatus !== 'running') setTimeout(done, 800)
  })
  ws.on('error', (e) => log('WS 错误', e.message))

  await Promise.race([finished, new Promise((r) => setTimeout(r, 240_000))])
  ws.close()
  log('Agent 回复:', (chat[0] ?? '(无)').slice(0, 160).replace(/\n/g, ' '))

  // ── 2. 桌面层：X 上的窗口标题
  const titles = await sbx.commands.run(
    'DISPLAY=:1 xdotool search --onlyvisible --class chromium getwindowname %@ 2>/dev/null || true',
  )
  const titleText = (titles.stdout ?? '').trim()
  log(`X 上的 Chromium 窗口标题: ${JSON.stringify(titleText)}`)
  results.windowTitle = /example/i.test(titleText)

  // ── 3. 像素层：截 X 的图，确认不是纯色
  // 不用 ImageMagick（镜像里没有），xwd 抓原始帧然后数字节取值分布。
  // 先确认 xwd 在 —— 工具缺失和黑屏都会让计数变成 0，
  // 那种「探针坏了却报成断言失败」是最浪费时间的一类错。
  const hasXwd = await sbx.commands.run('command -v xwd || true')
  if (!(hasXwd.stdout ?? '').trim()) {
    throw new Error('沙箱里没有 xwd（应由 x11-apps 提供），像素层无法验证')
  }
  const px = await sbx.commands.run(
    'DISPLAY=:1 xwd -root -silent | od -An -tu1 -j 3000 -N 60000 | tr -s " " "\\n" | sort -u | wc -l',
  )
  const distinct = Number((px.stdout ?? '0').trim())
  log(`截图采样到 ${distinct} 种字节值`)
  // 纯色画面（全黑/全白）采样出来只有个位数种取值
  results.pixels = distinct > 20

  console.log('\n──────── 断言 ────────')
  const checks = [
    ['agent-runtime 就绪', !!results.runtime],
    ['VNC 协议握手成功（画面通道真的通）', results.rfbHandshake],
    ['X 桌面上的窗口标题与目标页面一致（同一个浏览器）', results.windowTitle],
    ['画面有实际内容（不是纯色黑屏）', results.pixels],
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
