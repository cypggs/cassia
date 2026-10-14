// 探针：pi 崩溃自愈的可行性验证（看门狗方案的事实依据）。
//   1. pi 会话落盘在哪、长什么样
//   2. get_state 的 response 形状（看门狗探活要用）
//   3. 重建的 pi 能否 switch_session 接回旧会话（上下文不丢）
//
//   node --env-file=.env scripts/probe-pirevive.mjs
import { spawn } from 'node:child_process'
import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const CWD = '/tmp/pi-wd-probe'
const SESSIONS_ROOT = join(homedir(), '.pi/agent/sessions')

function startPi() {
  const env = { ...process.env }
  const p = spawn('pi', [
    '--mode', 'rpc', '--no-extensions', '--no-skills',
    '--model', 'deepseek/deepseek-flash',
    '--thinking', 'off',
  ], { cwd: CWD, stdio: ['pipe', 'pipe', 'pipe'], env })
  p.stderr.on('data', () => {})
  return p
}

function makeClient(p) {
  let buf = ''
  const listeners = []
  p.stdout.on('data', (d) => {
    buf += d.toString()
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1)
      if (!line.trim()) continue
      let ev; try { ev = JSON.parse(line) } catch { continue }
      for (const fn of [...listeners]) fn(ev)
    }
  })
  return {
    send: (o) => p.stdin.write(JSON.stringify(o) + '\n'),
    waitFor: (pred, ms = 120_000) => new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('waitFor 超时')), ms)
      listeners.push((ev) => { if (pred(ev)) { clearTimeout(t); res(ev) } })
    }),
  }
}

const sessionsOf = () => {
  // cwd 编码目录名：pi 把 cwd 编码成安全目录名，直接找最近修改的
  if (!existsSync(SESSIONS_ROOT)) return []
  return readdirSync(SESSIONS_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(SESSIONS_ROOT, e.name))
}

const before = new Set(sessionsOf())
console.log('已有会话目录:', before.size)

// ── 第一轮：让它记住一个数字
let pi = startPi()
let c = makeClient(pi)
await c.waitFor((e) => e.type === 'response').catch(() => {}) // ready
c.send({ type: 'prompt', message: '记住数字 8787。只回复 ok 两个字。' })
await c.waitFor((e) => e.type === 'agent_settled')
console.log('✓ 第一轮完成，数字已告知')

// get_state 的 response 形状
c.send({ type: 'get_state' })
const gs = await c.waitFor((e) => e.type === 'response' && e.command === 'get_state', 10_000)
console.log('✓ get_state response:', JSON.stringify(gs).slice(0, 300))

pi.kill('SIGKILL')
await new Promise((r) => setTimeout(r, 500))

// ── 找落盘的会话文件：认 cwd 编码出来的那个目录，文件名是时间戳前缀，取最新
const dir = sessionsOf().find((d) => d.endsWith('pi-wd-probe--'))
const candidates = dir
  ? readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort().map((f) => join(dir, f))
  : []
console.log('会话目录:', dir, '文件数:', candidates.length)

// ── 第二轮：重建 pi，接回旧会话
pi = startPi()
c = makeClient(pi)
await c.waitFor((e) => e.type === 'response').catch(() => {})

if (candidates.length) {
  const target = candidates[candidates.length - 1]
  c.send({ type: 'switch_session', sessionPath: target })
  const sw = await c.waitFor((e) => e.type === 'response' && e.command === 'switch_session', 10_000).catch((e) => e)
  console.log('switch_session:', JSON.stringify(sw).slice(0, 300))
}

c.send({ type: 'prompt', message: '我刚才让你记住的数字是什么？只回答数字。' })
await c.waitFor((e) => e.type === 'agent_settled')
c.send({ type: 'get_last_assistant_text' })
const lr = await c.waitFor((e) => e.type === 'response' && e.command === 'get_last_assistant_text', 10_000)
const text = JSON.stringify(lr.data ?? '')
console.log(text.includes('8787') ? `✓ 上下文接回来了: ${text.slice(0, 120)}` : `✗ 上下文丢失: ${text.slice(0, 200)}`)
pi.kill('SIGKILL')
