// 单元级复现：直接驱动 PersistentShell 跑用户卡死的那些命令。
//   npx tsx scripts/probe-unit-shell.mts
import { PersistentShell } from '../agent-runtime/pi-extension/persistent-shell.ts'

const shell = new PersistentShell(process.cwd())

async function run(name, command, opts = {}, expectHang = false) {
  const t0 = Date.now()
  let out = ''
  try {
    const r = await shell.exec(command, process.cwd(), {
      onData: (d) => { out += d.toString() },
      ...opts,
    })
    const dt = ((Date.now() - t0) / 1000).toFixed(1)
    if (expectHang) {
      console.log(`✗ ${name}: 应该超时却完成了 exit=${r.exitCode}`)
      return false
    }
    console.log(`✓ ${name}: ${dt}s 完成 exit=${r.exitCode} 输出=${JSON.stringify(out.slice(-120))}`)
    return true
  } catch (e) {
    const dt = ((Date.now() - t0) / 1000).toFixed(1)
    if (expectHang && String(e.message).startsWith('timeout:')) {
      console.log(`✓ ${name}: ${dt}s 按预期被超时打断（Ctrl-C 生效）`)
      return true
    }
    console.log(`✗ ${name}: ${dt}s 异常 ${e.message}  输出=${JSON.stringify(out.slice(-120))}`)
    return false
  }
}

let ok = true
ok = await run('echo 基线', 'echo baseline-ok') && ok
ok = await run('sudo -n（线上卡死的命令）', 'sudo -n true 2>&1 && echo "sudo ok" || echo "no passwordless sudo"; echo "tail-end"') && ok
ok = await run('多行 heredoc', "cat > /tmp/unit-probe.js << 'EOF'\nconsole.log('line1')\nconsole.log('line2')\nEOF\necho wrote") && ok
ok = await run('常驻进程（超时 Ctrl-C）', 'node -e "setInterval(()=>{},1e3)"', { timeout: 3 }, true) && ok
// 上一条被 Ctrl-C 杀掉后，队列必须还能继续 —— 这条卡死说明会话级坏死
ok = await run('超时后的下一条', 'echo still-alive') && ok
ok = await run('管道读 stdin 的命令', 'printf "a\\nb\\n" | head -1') && ok
process.exit(ok ? 0 : 1)
