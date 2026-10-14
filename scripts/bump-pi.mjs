/**
 * pi 版本保鲜流水线：pin + 测试门禁的 bump，绝不盲升 latest。
 *
 * pi 大约每周一版，而我们的扩展耦合它的内部 API（persistent-shell 用
 * createBashTool，plan 用 ExtensionAPI/registerTool，pi-client 用 RPC
 * get_state/switch_session 语义）——任何 breaking change 都得先过门禁再进镜像。
 *
 * 流程：
 *   1. 发现   npm latest vs 三个钉版点（2 Dockerfile + agent-runtime devDep）
 *   2. 变更日志 GitHub releases 拉区间说明，Breaking Changes 高亮，需人工确认
 *   3. 本机门禁 本机 pi 必须先升到目标版（probes 直接 spawn PATH 上的 pi），
 *             然后 probe-shell / probe-plan / probe-watchdog 全绿
 *   4. 改钉版 改三个文件 + pnpm install 更新锁
 *   5. 重建   两个 E2B 模板都重建（--skip-build 可跳过）
 *   6. 全链路 :4000 活着就跑 test:e2e / test:shell / test:plan / test:chaos
 *
 * 用法：
 *   node scripts/bump-pi.mjs --check            # 只报告，不改动（可挂周检）
 *   node scripts/bump-pi.mjs                    # 完整流水线
 *   node scripts/bump-pi.mjs --to 0.83.0 --yes  # 指定版本、跳过确认
 */
import { execFileSync, execSync, spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const PKG = '@earendil-works/pi-coding-agent'
const PINS = [
  { file: 'sandbox-lite/e2b.Dockerfile', re: /(?<pre>@earendil-works\/pi-coding-agent@)(?<ver>\d+\.\d+\.\d+)/ },
  { file: 'sandbox-desktop/e2b.Dockerfile', re: /(?<pre>@earendil-works\/pi-coding-agent@)(?<ver>\d+\.\d+\.\d+)/ },
  { file: 'agent-runtime/package.json', re: /(?<pre>"@earendil-works\/pi-coding-agent":\s*")(?<ver>\d+\.\d+\.\d+)(?<post>")/ },
]
const PROBES = ['scripts/probe-shell.mjs', 'scripts/probe-plan.mjs', 'scripts/probe-watchdog.mjs']
const E2E = ['test:e2e', 'test:shell', 'test:plan', 'test:chaos']

const args = process.argv.slice(2)
const flag = (n) => args.includes(n.startsWith('--') ? n : `--${n}`)
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined }

const sh = (cmd, opts = {}) => execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim()
const run = (cmd, cmdArgs, env) => new Promise((resolve) => {
  console.log(`\n$ ${cmd} ${cmdArgs.join(' ')}`)
  const c = spawn(cmd, cmdArgs, { stdio: 'inherit', env: env ?? process.env })
  c.on('exit', (code) => resolve(code === 0))
})
const die = (msg) => { console.error(`\n✗ ${msg}`); process.exit(1) }
const ok = (msg) => console.log(`✓ ${msg}`)

// ── 1. 发现 ────────────────────────────────────────────────
const latest = opt('to') ?? sh(`npm view ${PKG} version`)
const pins = PINS.map(({ file, re }) => {
  const m = readFileSync(file, 'utf8').match(re)
  if (!m?.groups?.ver) die(`${file} 里找不到 ${PKG} 的版本钉`)
  return { file, re, version: m.groups.ver }
})
const current = pins[0].version
console.log(`钉版: ${pins.map((p) => `${p.file}=${p.version}`).join('  ')}`)
console.log(`npm latest: ${latest}`)
if (pins.some((p) => p.version !== current)) die('三个钉版点版本不一致，先手工对齐')
if (flag('check')) {
  console.log(current === latest ? '\n已是最新。' : `\n可升级: ${current} → ${latest}`)
  process.exit(0)
}
if (current === latest) { ok('已是最新，无事可做'); process.exit(0) }

// ── 2. 变更日志 ─────────────────────────────────────────────
let breaking = ''
try {
  const rels = JSON.parse(sh(`curl -sf 'https://api.github.com/repos/earendil-works/pi/releases?per_page=30'`))
  const inRange = rels.filter((r) => r.tag_name > `v${current}` && r.tag_name <= `v${latest}`)
  console.log('\n═══ 变更日志 ═══')
  for (const r of inRange) {
    console.log(`\n── ${r.tag_name} (${r.published_at?.slice(0, 10)}) ──`)
    console.log((r.body ?? '').split('\n').slice(0, 25).join('\n'))
  }
  breaking = inRange.map((r) => r.body ?? '').filter((b) => /breaking/i.test(b)).join('\n')
  if (breaking) console.log('\n⚠️  区间内存在 BREAKING CHANGES（见上），确认扩展不受影响再继续。')
} catch { console.log('（变更日志拉取失败，跳过 —— 请自行到 GitHub releases 核对）') }

if (!flag('yes')) {
  if (!process.stdin.isTTY) die('非交互终端，确认无误后加 --yes 重跑')
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const ans = await new Promise((r) => rl.question(`\n继续升级 ${current} → ${latest}？[y/N] `, r))
  rl.close()
  if (!/^y/i.test(ans)) die('已取消')
}

// ── 3. 本机门禁 ─────────────────────────────────────────────
const localPi = sh('pi --version')
if (localPi !== latest)
  die(`本机 pi 是 ${localPi}，探针测的是 PATH 上的 pi —— 先 npm i -g ${PKG}@${latest} 再重跑`)
ok(`本机 pi ${localPi} == 目标版本`)

for (const probe of PROBES) {
  console.log(`\n── 本机门禁: ${probe} ──`)
  if (!(await run('node', ['--env-file=.env', probe]))) die(`${probe} 失败 —— 新版本与本平台扩展不兼容，钉版不动`)
  ok(probe)
}

// ── 4. 改钉版 ───────────────────────────────────────────────
for (const { file, re } of pins) {
  const src = readFileSync(file, 'utf8')
  writeFileSync(file, src.replace(re, (...a) => {
    const g = a.at(-1)
    return `${g.pre}${latest}${g.post ?? ''}`
  }))
  ok(`${file} → ${latest}`)
}
if (!(await run('pnpm', ['install', '--filter', '@cassia/agent-runtime']))) die('pnpm install 失败')
ok('锁文件已更新')

// ── 5. 重建模板 ─────────────────────────────────────────────
if (flag('skip-build')) {
  console.log('\n（--skip-build：跳过模板重建，记得之后手动 ./sandbox-*/build.sh）')
} else {
  for (const b of ['sandbox-lite/build.sh', 'sandbox-desktop/build.sh']) {
    console.log(`\n── 重建模板: ${b} ──`)
    if (!(await run(`./${b}`, []))) die(`${b} 构建失败`)
    ok(b)
  }
}

// ── 6. 全链路门禁 ───────────────────────────────────────────
let alive = false
try { execFileSync('curl', ['-sf', '-m', '3', 'http://localhost:4000/healthz']); alive = true } catch {}
if (!alive) {
  console.log('\n:4000 没在跑。启动 socket-server（E2B 模式）后手动跑门禁：')
  console.log(`  ${E2E.map((t) => `pnpm ${t}`).join(' && ')}`)
  process.exit(0)
}
for (const t of E2E) {
  console.log(`\n── 全链路门禁: ${t} ──`)
  if (!(await run('pnpm', [t]))) die(`${t} 失败 —— 镜像已重建但链路有回归，钉版已改，请排查后决定回退或修复`)
  ok(t)
}

console.log(`\n✓ ${current} → ${latest} 全部门禁通过，镜像内 pi 已保鲜。`)
