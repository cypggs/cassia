// Probe: pi + persistent-shell 扩展 —— 输出必须干净（无回显/横幅/提示符），
// 且 export/cd 要跨调用存活。
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const cwd = mkdtempSync(join(tmpdir(), 'pi-probe-sh-'))
const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const EXT = join(REPO, 'agent-runtime/pi-extension/persistent-shell.ts')

const child = spawn('pi', [
  '--mode', 'rpc', '--model', 'deepseek/deepseek-flash',
  '--thinking', 'off', '--no-session', '--no-extensions', '--no-skills',
  '-e', EXT,
], { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PI_OFFLINE: '1' } })

let buf = ''
const results = []
let n = 0
child.stdout.on('data', (d) => {
  buf += d.toString()
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i)
    buf = buf.slice(i + 1)
    if (!line.trim()) continue
    let ev
    try { ev = JSON.parse(line) } catch { continue }
    if (ev.type === 'tool_execution_start' && ev.toolName === 'bash')
      console.log(`\n═══ CALL ${++n}: ${JSON.stringify(ev.args?.command).slice(0, 140)}`)
    else if (ev.type === 'tool_execution_update' && n > 0) {
      const t = (ev.partialResult?.content || []).map((c) => c.text || '').join('')
      if (t.length) console.log(`  [partial ${t.length}B]`)
    } else if (ev.type === 'tool_execution_end') {
      const text = (ev.result?.content || []).map((c) => c.text || '').join('')
      results.push(text)
      console.log(`─── RESULT ${n} (verbatim):`)
      console.log(JSON.stringify(text))
    } else if (ev.type === 'agent_settled') {
      finish()
    }
  }
})
child.stderr.on('data', (d) => {
  const s = d.toString()
  if (!s.includes('Warning:')) process.stderr.write('[e] ' + s)
})

function finish() {
  console.log('\n════════ 判定 ════════')
  const joined = results.join('\n')
  const checks = [
    ['VAR 跨调用存活', joined.includes('hello123')],
    ['cd 跨调用存活', joined.includes('/tmp')],
    ['无启动横幅/回显（call 1 不含 export 命令本身）', !results[0]?.includes('PI_PROBE_VAR=hello123') || results[0]?.trim().split('\n').length <= 3],
    ['无 bash 提示符', !/bash-[\d.]+[\$#]/.test(joined)],
    ['无 heredoc 续行符', !/(?:^|[\r\n])[^\S\r\n]*(?:>+ )+(?=\S)/.test(joined.replace(/^>+ /, '')) && !joined.match(/^(?:>+ )+/m)],
    ['heredoc 三行都在', joined.includes('line one: hello') && joined.includes('line two: world') && joined.includes('line three: !')],
  ]
  let ok = true
  for (const [name, pass] of checks) {
    if (!pass) ok = false
    console.log(`  ${pass ? '✓' : '✗'} ${name}`)
  }
  console.log(ok ? 'PASS' : 'FAIL')
  child.kill()
  process.exit(ok ? 0 : 1)
}

setTimeout(() => {
  child.stdin.write(JSON.stringify({
    type: 'prompt',
    message:
      'Run these three bash commands IN ORDER, one tool call each. ' +
      '1) export PI_PROBE_VAR=hello123 && cd /tmp && echo setup-done  ' +
      '2) echo "var=$PI_PROBE_VAR pwd=$PWD"  ' +
      '3) cat <<EOF\nline one: hello\nline two: world\nline three: !\nEOF  ' +
      'Then reply DONE.',
  }) + '\n')
}, 1500)
setTimeout(() => { console.log('TIMEOUT'); finish() }, 120_000)
