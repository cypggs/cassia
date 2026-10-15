import { WaffoPancake } from '@waffo/pancake-ts'
import type { CreditOrder } from '../store.js'

/**
 * waffo 支付通道（托管收银台 + webhook 回执）。
 *
 * 凭证只走环境变量（VM .env.production，chmod 600），绝不进库不进前端。
 * 私钥在 env 里通常是单行 \n 转义 —— 读出来先还原成真实 PEM。
 *
 * 产品侧：三档一次性积分包由 scripts/waffo-setup.mjs 一次性建好（测试模式），
 * productId 写回 env —— 这里只读，不现场建品（建品是管理操作，不是热路径）。
 */

export interface Pack {
  /** 包标识（订单流水的 pack 列） */
  key: string
  /** waffo 侧 productId（env 注入） */
  productId: string
  /** 展示金额（waffo 的字符串约定） */
  amount: string
  /** 到账积分 */
  credits: number
}

/** 三档定价：大额多送（500/2200/5800 ≈ 1.0x/1.1x/1.16x 面值） */
const PACK_DEFS = [
  { key: 'pack_500', env: 'WAFFO_PRODUCT_PACK_500', amount: '5.00', credits: 500 },
  { key: 'pack_2000', env: 'WAFFO_PRODUCT_PACK_2000', amount: '20.00', credits: 2200 },
  { key: 'pack_5000', env: 'WAFFO_PRODUCT_PACK_5000', amount: '50.00', credits: 5800 },
] as const

export const packs: Pack[] = PACK_DEFS
  .map((d) => ({ key: d.key, productId: process.env[d.env] ?? '', amount: d.amount, credits: d.credits }))
  .filter((p) => p.productId)

const merchantId = process.env.WAFFO_MERCHANT_ID ?? ''
const privateKey = (process.env.WAFFO_PRIVATE_KEY ?? '').replace(/\\n/g, '\n')

/** 支付通道是否可用（缺凭证/缺产品就静默关闭，积分治理本身不受影响） */
export const waffoEnabled = !!(merchantId && privateKey && packs.length)

export const waffo = waffoEnabled ? new WaffoPancake({ merchantId, privateKey }) : null

/** 前端地址：checkout 支付成功后跳回这里 */
const appOrigin = process.env.APP_ORIGIN ?? 'http://localhost:3000'

/**
 * 给一笔本地订单开托管收银台会话。metadata.orderId 是我们和 webhook
 * 之间的唯一纽带 —— webhook 回来只靠它找到该给哪笔单入账。
 */
export async function createCheckout(order: CreditOrder, buyerEmail?: string): Promise<string> {
  if (!waffo) throw new Error('waffo 未配置')
  const session = await waffo.checkout.createSession({
    productId: order.productId,
    currency: 'USD',
    buyerEmail,
    successUrl: `${appOrigin}/?checkout=success`,
    expiresInSeconds: 45 * 60,
    metadata: { orderId: order.id },
    orderMerchantExternalId: order.id,
  })
  return session.checkoutUrl
}
