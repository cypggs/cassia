import type { Metadata } from 'next'
import Link from 'next/link'
import { I18nProvider } from '@/lib/i18n'
import { SUPPORT_EMAIL } from '@/lib/i18n'
import { LegalFrame } from '@/components/LegalFrame'

export const metadata: Metadata = {
  title: 'Pricing — Cassia',
  description: 'Cassia pricing: prepaid credits, one-time packs, free trial',
}

const PACKS = [
  { name: 'Starter', price: '$5', credits: '500', note: 'Try real workloads', noteZh: '适合体验真实任务' },
  { name: 'Builder', price: '$20', credits: '2,200', note: '+10% bonus credits', noteZh: '多送 10% 积分' },
  { name: 'Pro', price: '$50', credits: '5,800', note: '+16% bonus credits', noteZh: '多送 16% 积分' },
]

export default function PricingPage() {
  return (
    <I18nProvider>
      <LegalFrame en={<En />} zh={<Zh />} />
    </I18nProvider>
  )
}

function PackCards({ zh }: { zh?: boolean }) {
  return (
    <div className="packs">
      {PACKS.map((p) => (
        <div className="pack-card" key={p.name}>
          <div className="pack-name">{p.name}</div>
          <div className="pack-price">{p.price}</div>
          <div className="pack-credits">💎 {p.credits} {zh ? '积分' : 'credits'}</div>
          <div className="pack-note dim">{zh ? p.noteZh : p.note}</div>
        </div>
      ))}
    </div>
  )
}

function En() {
  return (
    <>
      <h1>Pricing</h1>
      <p className="legal-meta">Last updated: August 5, 2026</p>

      <p>
        Cassia is pay-as-you-go: you buy credits once, and tasks deduct credits based on
        the compute they actually use. No subscriptions, no recurring charges.
      </p>

      <h2>Free trial</h2>
      <p>
        Every new account receives <strong>100 credits free</strong> — enough to run your
        first tasks end to end. No card required.
      </p>

      <h2>Credit packs</h2>
      <PackCards />
      <p>
        Each pack is a <strong>one-time purchase</strong>. Checkout is hosted by our
        payment processor, <strong>Waffo Pancake</strong>; we never see or store your card
        details.
      </p>

      <h2>How credits are spent</h2>
      <ul>
        <li><strong>1 credit = USD $0.01</strong> of face value.</li>
        <li>
          Each task reports its real model compute cost when it finishes; we deduct that
          cost <strong>×2</strong> in credits. The multiplier covers sandbox compute,
          bandwidth, and payment processing — there are no separate infra fees.
        </li>
        <li>Your remaining balance and full transaction ledger are always visible in the product.</li>
        <li>When your balance runs out, new tasks are stopped until you top up; the currently running step always finishes.</li>
        <li>A per-session spending cap protects you from runaway tasks.</li>
      </ul>

      <h2>Fine print</h2>
      <ul>
        <li>Purchased credits are valid for <strong>12 months</strong> from purchase.</li>
        <li>
          Unused purchased credits can be refunded within <strong>7 days</strong> of
          purchase — email <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> with
          your order reference.
        </li>
        <li>Credits already consumed by executed tasks are non-refundable.</li>
        <li>Duplicate or erroneous charges are refunded in full.</li>
      </ul>
      <p>
        Full details in the <Link href="/terms">Terms of Service</Link> and{' '}
        <Link href="/privacy">Privacy Policy</Link>.
      </p>
    </>
  )
}

function Zh() {
  return (
    <>
      <h1>定价</h1>
      <p className="legal-meta">最后更新：2026 年 8 月 5 日</p>

      <p>
        Cassia 采用按量付费：积分一次购买，任务按实际算力消耗扣减。没有订阅，
        没有周期性扣费。
      </p>

      <h2>免费试用</h2>
      <p>
        每个新账户都可获得 <strong>100 免费积分</strong>——足够完整跑完你的第一批任务。
        无需绑卡。
      </p>

      <h2>积分包</h2>
      <PackCards zh />
      <p>
        每个积分包都是<strong>一次性购买</strong>。收银台由我们的支付处理方
        <strong> Waffo Pancake</strong> 托管，我们从不查看或存储你的银行卡信息。
      </p>

      <h2>积分如何消耗</h2>
      <ul>
        <li><strong>1 积分 = 0.01 美元</strong>面值。</li>
        <li>
          每个任务结束后上报真实模型算力成本，按该成本的 <strong>×2</strong> 扣减积分。
          倍率已覆盖沙箱算力、带宽和支付通道费——没有单独的基础设施费用。
        </li>
        <li>余额和完整交易流水始终在产品内可见。</li>
        <li>余额耗尽后将无法开始新任务，直到充值；进行中的步骤会正常跑完。</li>
        <li>每个会话设有消费上限，防止任务失控。</li>
      </ul>

      <h2>细则</h2>
      <ul>
        <li>已购积分自购买之日起 <strong>12 个月</strong>内有效。</li>
        <li>
          未使用的已购积分可在购买后 <strong>7 天</strong>内退款——请携带订单号发送邮件至{' '}
          <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>。
        </li>
        <li>已被任务消耗的积分不予退款。</li>
        <li>重复或错误扣款全额退还。</li>
      </ul>
      <p>
        完整细节见<Link href="/terms">服务条款</Link>和<Link href="/privacy">隐私政策</Link>。
      </p>
    </>
  )
}
