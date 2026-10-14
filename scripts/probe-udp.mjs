// 探针：E2B 的端口转发走不走 UDP（neko WebRTC 媒体面的生死问题）
// 沙箱里跑 UDP echo，外面向 <port>-<id>.e2b.app 的 443/同号端口发 UDP，看回不回
import { Sandbox } from 'e2b'
import dgram from 'node:dgram'
import dns from 'node:dns/promises'

const sbx = await Sandbox.create('cassia-lite', { timeoutMs: 5 * 60 * 1000 })
const id = sbx.sandboxId
console.log('sandbox', id)

// UDP echo server on 59001
await sbx.commands.run(
  `nohup node -e "
    const s = require('dgram').createSocket('udp4')
    s.on('message', (m, r) => s.send('ECHO:' + m, r.port, r.address))
    s.bind(59001, '0.0.0.0', () => console.log('udp echo up'))
  " > /tmp/udp.log 2>&1 &`,
  { timeout: 5000 },
)
await new Promise((r) => setTimeout(r, 1500))
console.log('udp log:', (await sbx.commands.run('cat /tmp/udp.log', { timeout: 5000 })).stdout.trim())

// E2B 的公开主机名格式
const host = sbx.getHost(59001)
console.log('public host:', host)
const ips = await dns.lookup(host, { all: true }).catch((e) => e.message)
console.log('DNS:', JSON.stringify(ips))
if (typeof ips === 'string') { await sbx.kill(); process.exit(1) }

// 向该 IP 的 59001 和 443 各发 3 个 UDP 包，等 3s 回声
const tryUdp = (ip, port) => new Promise((resolve) => {
  const sock = dgram.createSocket('udp4')
  const done = (v) => { try { sock.close() } catch {}; resolve(v) }
  sock.on('message', (m) => done(`GOT REPLY: ${m}`))
  sock.on('error', () => done(false))
  let n = 0
  const t = setInterval(() => {
    if (++n > 3) { clearInterval(t); setTimeout(() => done(false), 2000); return }
    sock.send(`ping${n}`, port, ip)
  }, 500)
  setTimeout(() => { clearInterval(t); done(false) }, 6000)
})

for (const port of [59001, 443]) {
  const r = await tryUdp(ips[0].address, port)
  console.log(`UDP -> ${ips[0].address}:${port}  ${r || 'NO REPLY (黑洞)'}`)
}
await sbx.kill()
