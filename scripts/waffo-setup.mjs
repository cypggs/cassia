#!/usr/bin/env node
/**
 * waffo 一次性初始化：建三档积分包（onetime products）+ 注册 webhook。
 *
 * 用法（凭证从环境读，不进命令行参数 —— 不留在 shell history）：
 *   set -a && source .env && set +a
 *   node scripts/waffo-setup.mjs
 *
 * 需要的环境变量：
 *   WAFFO_MERCHANT_ID / WAFFO_PRIVATE_KEY —— 商户凭证
 *   WAFFO_STORE_ID（可选，默认 = MERCHANT_ID）
 *   APP_ORIGIN（可选，默认 https://YOUR_DOMAIN —— webhook 回调目标）
 *   WAFFO_TEST_MODE（可选，默认 1 = 测试模式；上生产传 0）
 *
 * 测试模式建的产品用测试卡（4576750000000110 成功 / 4576750000000220 拒付）
 * 走全额流程不产生真实扣款；生产模式（WAFFO_TEST_MODE=0 + 生产私钥）建的是
 * 真实收费产品。代码零改动，只换凭证和产品 ID。
 *
 * 跑完把打印的三个 WAFFO_PRODUCT_* 写进 VM .env.production。
 */
import { createRequire } from 'node:module'

// 依赖装在 socket-server 里，从仓库根跑也要解析得到
const require = createRequire(new URL('../socket-server/package.json', import.meta.url))
const { WaffoPancake, TaxCategory } = await import(require.resolve('@waffo/pancake-ts'))

const merchantId = process.env.WAFFO_MERCHANT_ID
const privateKey = (process.env.WAFFO_PRIVATE_KEY ?? '').replace(/\\n/g, '\n')
const storeId = process.env.WAFFO_STORE_ID ?? merchantId
const appOrigin = process.env.APP_ORIGIN ?? 'https://YOUR_DOMAIN'
const testMode = process.env.WAFFO_TEST_MODE !== '0'

if (!merchantId || !privateKey) {
  console.error('缺 WAFFO_MERCHANT_ID / WAFFO_PRIVATE_KEY（set -a && source .env && set +a）')
  process.exit(1)
}

const client = new WaffoPancake({ merchantId, privateKey })

// 与 socket-server/src/commercial/waffo.ts 的 PACK_DEFS 一一对应 —— 改价要两边一起改
const PACKS = [
  { env: 'WAFFO_PRODUCT_PACK_500', name: 'Cassia — 500 积分', amount: '5.00', credits: 500 },
  { env: 'WAFFO_PRODUCT_PACK_2000', name: 'Cassia — 2200 积分', amount: '20.00', credits: 2200 },
  { env: 'WAFFO_PRODUCT_PACK_5000', name: 'Cassia — 5800 积分', amount: '50.00', credits: 5800 },
]

console.log(`merchant=${merchantId} store=${storeId}（${testMode ? '测试模式' : '★ 生产模式 ★'}）\n`)

for (const p of PACKS) {
  const { product } = await client.onetimeProducts.create({
    storeId,
    name: p.name,
    description: `Cassia 积分包：${p.credits} 积分（1 积分 = $0.01 面值）`,
    prices: { USD: { amount: p.amount, taxCategory: TaxCategory.SaaS } },
    metadata: { pack: p.env.replace('WAFFO_PRODUCT_', '').toLowerCase(), credits: String(p.credits) },
  })
  console.log(`${p.env}=${product.id}  （${p.name} / $${p.amount}）`)
}

const { webhook } = await client.webhooks.add({
  storeId,
  channel: 'http',
  url: `${appOrigin}/webhooks/waffo`,
  events: ['order.completed'],
  testMode,
})
console.log(`\nwebhook: ${webhook.id} → ${appOrigin}/webhooks/waffo（${testMode ? 'testMode' : '生产'}）`)
console.log('\n把上面三行 WAFFO_PRODUCT_* 写进 VM 的 .env.production，然后重启 socket-server。')
