// 验证：cassia-lite 沙箱在内存负载下会不会被 E2B 回收（C 场景悬案）
import { Sandbox } from 'e2b'

const stateOf = async (id) => {
  const p = await Sandbox.list()
  while (p.hasNext ?? p._hasNext) {
    const items = await p.nextItems()
    const f = items.find((s) => s.sandboxId === id)
    if (f) return f.state
  }
  return 'gone'
}

const sbx = await Sandbox.create('cassia-lite', {
  timeoutMs: 30 * 60 * 1000,
  envs: { PI_MODEL: 'deepseek/deepseek-flash' },
  lifecycle: { onTimeout: { action: 'pause' }, autoResume: false },
})
const id = sbx.sandboxId
console.log('created', id)
const host = sbx.getHost(8330)
for (let i = 0; i < 45; i++) {
  try { if ((await fetch(`https://${host}/healthz`, { signal: AbortSignal.timeout(3000) })).ok) break } catch {}
  await new Promise((r) => setTimeout(r, 1000))
}
console.log('healthy，上内存负载（每 0.5s 多吃 ~8MB）')
await sbx.commands.run(
  `nohup node -e "const a=[]; setInterval(()=>a.push(new Array(1e6).fill(0)), 500)" > /dev/null 2>&1 &`,
  { timeout: 5000 },
).catch((e) => console.log('load cmd err', e.message))

let last = ''
for (let i = 0; i < 36; i++) {
  const s = await stateOf(id)
  if (s !== last) console.log(`+${i * 10}s  state: ${s}`)
  last = s
  if (s === 'gone') break
  await new Promise((r) => setTimeout(r, 10000))
}
console.log('final:', await stateOf(id))
await sbx.kill().catch(() => {})
