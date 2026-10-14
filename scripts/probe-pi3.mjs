// Probe 3: when the MODEL calls bash on a slow command, do we get incremental streaming?
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const cwd = mkdtempSync(join(tmpdir(), 'pi-probe3-'))
const child = spawn('pi', ['--mode', 'rpc', '--model', 'deepseek/deepseek-flash',
  '--thinking', 'off', '--no-session', '--no-extensions', '--no-skills'],
  { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PI_OFFLINE: '1' } })

let buf = ''; const t0 = Date.now(); const seen = new Set()
child.stdout.on('data', d => {
  buf += d.toString(); let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (!line.trim()) continue
    let ev; try { ev = JSON.parse(line) } catch { continue }
    seen.add(ev.type)
    const dt = ((Date.now() - t0) / 1000).toFixed(1)
    if (ev.type === 'bash_execution_update') console.log(`+${dt}s  bash_execution_update delta=${JSON.stringify(ev.delta)}`)
    else if (ev.type === 'tool_execution_start') console.log(`+${dt}s  START ${ev.toolName} ${JSON.stringify(ev.args).slice(0,160)}`)
    else if (ev.type === 'tool_execution_update') {
      const t = (ev.partialResult?.content||[]).map(c=>c.text||'').join('')
      console.log(`+${dt}s  update len=${t.length} tail=${JSON.stringify(t.slice(-40))}`)
    }
    else if (ev.type === 'tool_execution_end') console.log(`+${dt}s  END len=${((ev.result?.content||[]).map(c=>c.text||'').join('')).length}`)
    else if (ev.type === 'agent_settled') { console.log(`+${dt}s  agent_settled`); console.log('types:', [...seen].join(', ')); child.kill(); process.exit(0) }
  }
})
child.stderr.on('data', d => { const s = d.toString(); if (!s.includes('Warning:')) process.stderr.write('[e] ' + s) })

setTimeout(() => child.stdin.write(JSON.stringify({ type: 'prompt',
  message: 'Use the bash tool to run exactly this one command: for i in 1 2 3 4 5 6; do echo "tick $i"; sleep 1; done   -- then reply DONE.' }) + '\n'), 1500)
setTimeout(() => { console.log('TIMEOUT'); console.log('types:', [...seen].join(', ')); child.kill(); process.exit(0) }, 90000)
