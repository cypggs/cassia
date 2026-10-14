// Probe pi --mode rpc: capture the real event stream for a bash task.
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const cwd = mkdtempSync(join(tmpdir(), 'pi-probe-'))
writeFileSync(join(cwd, 'hello.txt'), 'hello from probe\n')

const child = spawn('pi', [
  '--mode', 'rpc',
  '--model', 'deepseek/deepseek-flash',
  '--thinking', 'off',
  '--no-session',
  '--no-extensions',
  '--no-skills',
], { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PI_OFFLINE: '1' } })

const events = []
let buf = ''
child.stdout.on('data', (d) => {
  buf += d.toString()
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (!line.trim()) continue
    try {
      const ev = JSON.parse(line)
      events.push(ev)
      // print a compact view
      const { type, ...rest } = ev
      const keys = Object.keys(rest)
      console.log(`[${String(events.length).padStart(3)}] ${type}  keys=${JSON.stringify(keys)}`)
      if (['tool_call', 'bash_execution_update', 'tool_execution_start', 'tool_execution_update', 'tool_execution_end', 'tool_result', 'agent_start', 'agent_end', 'agent_settled', 'turn_start'].includes(type)) {
        console.log('      ' + JSON.stringify(ev).slice(0, 500))
      }
    } catch { console.log('[non-json] ' + line.slice(0, 200)) }
  }
})
child.stderr.on('data', (d) => process.stderr.write('[stderr] ' + d))

const send = (o) => child.stdin.write(JSON.stringify(o) + '\n')

setTimeout(() => {
  send({ type: 'prompt', message: 'Run `ls -la` then `cat hello.txt` in the current directory using bash. Then say DONE.' })
}, 1500)

const done = () => {
  writeFileSync('./pi-events.jsonl',
    events.map(e => JSON.stringify(e)).join('\n'))
  console.log(`\n=== captured ${events.length} events -> pi-events.jsonl ===`)
  child.kill()
  process.exit(0)
}
setTimeout(done, 75000)
child.on('exit', (c) => { console.log('pi exited', c); done() })
