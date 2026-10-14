/**
 * 生产真实链路验证：给测试用户开一张真实收银台会话（pack_500 / $5）。
 * 打印 checkoutUrl —— 拿去浏览器用测试卡支付，然后跑 verify 看余额。
 *
 *   node --env-file=.env scripts/prod-checkout.mjs          # 开收银台，打印 URL + 用户
 *   node --env-file=.env scripts/prod-checkout.mjs verify   # 查该用户余额/流水/订单
 */
import { io } from 'socket.io-client'

const INSFORGE_URL = process.env.NEXT_PUBLIC_INSFORGE_URL?.replace(/\/$/, '')
const ANON_KEY = process.env.NEXT_PUBLIC_INSFORGE_ANON_KEY
const SOCKET = 'https://YOUR_DOMAIN'
const EMAIL_FILE = '/tmp/cassia-prod-pay-user.txt'

async function userToken(email, password) {
  const signIn = () =>
    fetch(`${INSFORGE_URL}/api/auth/sessions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ANON_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }).then((r) => r.json())
  let body = await signIn()
  if (!body.accessToken) {
    await fetch(`${INSFORGE_URL}/api/auth/users`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ANON_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    body = await signIn()
  }
  if (!body.accessToken) throw new Error(`拿不到令牌：${JSON.stringify(body)}`)
  return body.accessToken
}

const connect = (token) =>
  new Promise((resolve, reject) => {
    const s = io(SOCKET, { transports: ['websocket'], auth: { token }, reconnection: false })
    s.on('connect', () => resolve(s))
    s.on('connect_error', reject)
  })
const emit = (s, ev, p) => new Promise((r) => s.emit(ev, p, r))

if (process.argv[2] === 'verify') {
  const email = (await import('node:fs')).readFileSync(EMAIL_FILE, 'utf8').trim()
  const token = await userToken(email, 'prod-pay-pass')
  const s = await connect(token)
  const w = await emit(s, 'get_wallet', {})
  console.log(`用户 ${email}`)
  console.log(`余额: ${w.balance} 积分`)
  console.log('流水:', w.ledger.map((l) => `${l.reason} ${l.delta > 0 ? '+' : ''}${l.delta} → ${l.balanceAfter}`).join('  |  '))
  s.close()
  process.exit(0)
}

const email = `prod-pay-${Date.now()}@cassia.dev`
const { writeFileSync } = await import('node:fs')
writeFileSync(EMAIL_FILE, email)
const token = await userToken(email, 'prod-pay-pass')
const s = await connect(token)
const w = await emit(s, 'get_wallet', {})
console.log(`测试用户 ${email}（试用余额 ${w.balance}）`)
const r = await emit(s, 'create_checkout', { pack: 'pack_500' })
s.close()
if (!r?.checkoutUrl) {
  console.error('create_checkout 失败')
  process.exit(1)
}
console.log(`\n收银台（测试卡 4576750000000110 成功 / 4576750000000220 拒付）：\n${r.checkoutUrl}`)
console.log('\n支付完成后跑：node --env-file=.env scripts/prod-checkout.mjs verify')
