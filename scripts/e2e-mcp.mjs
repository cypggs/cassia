/**
 * 端到端验证 MCP 链路（docs/12-mcp-design.md）：
 *
 *   控制面 MCP_SERVERS → provision 写 ~/.pi/agent/mcp.json → pi 连 server
 *   → agent 调用 mcp__<server>__<tool> → toolUsed 事件到达本脚本
 *
 * 前置：目标 socket-server 的 env 配了 MCP_SERVERS（无认证 stdio server，
 * 测试用 npx -y mcp-sequentialthinking-tools，来自 mcp.so，无需 key）。
 *
 *   SOCKET_URL=http://77.113.168.138 node scripts/e2e-mcp.mjs
 */
import { io } from 'socket.io-client'

const URL = process.env.SOCKET_URL ?? 'http://localhost:4000'
const TASK = process.argv[2] ??
  '你装了名为 seqthink 的 MCP 服务器，其中有工具 sequentialthinking_tools。' +
  '请调用它一次，记录一条思考（内容："MCP 链路测试"），其余参数按工具 schema 填。' +
  '调用成功后回复 DONE。不要用 bash 代替，直接调 MCP 工具。'

const s = io(URL, { transports: ['websocket'] })
const t0 = Date.now()
const mcpCalls = []
const toolNames = new Set()
let sessionId

const el = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(5)

s.on('connect', () => {
  console.log(`${el()}s  connected`)
  s.emit('create_session', {}, (sess) => {
    sessionId = sess.id
    console.log(`${el()}s  session ${sessionId}`)
    s.emit('join_session', { sessionId }, () => {
      s.emit('send_message', { sessionId, text: TASK })
      console.log(`${el()}s  → 要求调用 sequentialthinking_tools`)
    })
  })
})

s.on('event', ({ event: e }) => {
  switch (e.type) {
    case 'sandboxUpdate':
      console.log(`${el()}s  □ sandbox=${e.sandboxId}`)
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
      // MCP 等未知工具走 detail.other,action 是 pi 原始工具名(mcp__srv__tool)。
      // 匹配必须看这个字段 —— 匹配整个事件 JSON 会被 bash 命令文本误伤
      const rawTool = e.detail?.other?.action ?? ''
      const action = rawTool || e.message?.action || ''
      toolNames.add(action)
      const hit = /mcp__|sequentialthinking/i.test(rawTool)
      if (hit) mcpCalls.push(e)
      console.log(`${el()}s  ▸ [${e.status}] ${action} ${e.message?.param ?? ''}${hit ? '  ← MCP' : ''}`)
      break
    }
  }
})

function report() {
  console.log('\n──────── 断言 ────────')
  const checks = [
    ['至少一次 MCP 工具调用进入事件流', mcpCalls.length > 0],
    ['调用成功（status=success）', mcpCalls.some((e) => e.status === 'success')],
  ]
  console.log(`  本次会话出现过的工具: ${[...toolNames].join(', ') || '(无)'}`)
  let ok = true
  for (const [name, pass] of checks) {
    console.log(`  ${pass ? '✓' : '✗'} ${name}`)
    if (!pass) ok = false
  }
  console.log(ok ? '\nPASS' : '\nFAIL')
  s.close()
  process.exit(ok ? 0 : 1)
}

setTimeout(() => { console.error('\n超时'); report() }, 180_000)
