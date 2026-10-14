// Probe 2: does tool_execution_update stream INCREMENTALLY for a long-running command?
// And is pi's bash shell persistent across calls (cwd/env survive)?
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const cwd = mkdtempSync(join(tmpdir(), 'pi-probe2-'))

const child = spawn('pi', [
  '--mode', 'rpc', '--model', 'deepseek/deepseek-flash',
  '--thinking', 'off', '--no-session', '--no-extensions', '--no-skills',
], { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PI_OFFLINE: '1' } })

const events = []
let buf = ''
let t0 = Date.now()
child.stdout.on('data', (d) => {
  buf += d.toString()
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (!line.trim()) continue
    let ev; try { ev = JSON.parse(line) } catch { continue }
    events.push(ev)
    const dt = ((Date.now() - t0) / 1000).toFixed(1)
    if (ev.type === 'tool_execution_update') {
      const txt = (ev.partialResult?.content || []).map(c => c.text || '').join('')
      console.log(`+${dt}s update len=${txt.length} tail=${JSON.stringify(txt.slice(-60))}`)
    } else if (ev.type === 'tool_execution_start') {
      console.log(`+${dt}s START ${ev.toolName} ${JSON.stringify(ev.args).slice(0, 200)}`)
    } else if (ev.type === 'tool_execution_end') {
      const txt = (ev.result?.content || []).map(c => c.text || '').join('')
      console.log(`+${dt}s END   len=${txt.length} isError=${ev.isError} details=${JSON.stringify(ev.result?.details || {}).slice(0,200)}`)
    } else if (ev.type === 'message_update') {
      const e = ev.assistantMessageEvent
      if (events.filter(x => x.type === 'message_update').length <= 2) {
        console.log(`+${dt}s message_update assistantMessageEvent=${JSON.stringify(e).slice(0, 300)}`)
      }
    } else if (ev.type === 'agent_settled') {
      console.log(`+${dt}s agent_settled`)
    }
  }
})
child.stderr.on('data', d => process.stderr.write('[e] ' + d))

const send = o => child.stdin.write(JSON.stringify(o) + '\n')

// Direct bash command (bypasses the model) to test streaming precisely.
setTimeout(() => {
  console.log('--- direct bash: streaming test ---')
  send({ type: 'bash', command: 'for i in 1 2 3 4 5; do echo "tick $i"; sleep 1; done' })
}, 1500)

// Persistence test: set a var + cd, then read it back in a separate bash call.
setTimeout(() => {
  console.log('--- persistence test A ---')
  send({ type: 'bash', command: 'export PROBE_VAR=persisted; cd /tmp; pwd' })
}, 12000)
setTimeout(() => {
  console.log('--- persistence test B (same shell?) ---')
  send({ type: 'bash', command: 'echo "VAR=[$PROBE_VAR] PWD=[$(pwd)]"' })
}, 15000)

setTimeout(() => {
  writeFileSync('./pi-events2.jsonl',
    events.map(e => JSON.stringify(e)).join('\n'))
  console.log(`\n=== ${events.length} events ===`)
  console.log('types:', JSON.stringify([...new Set(events.map(e => e.type))]))
  child.kill(); process.exit(0)
}, 20000)
