import type { Metadata } from 'next'
import Link from 'next/link'
import { I18nProvider } from '@/lib/i18n'
import { SUPPORT_EMAIL } from '@/lib/i18n'
import { LegalFrame } from '@/components/LegalFrame'

export const metadata: Metadata = {
  title: 'Terms of Service — Cassia',
  description: 'Terms of Service for Cassia, operated by Cassia',
}

export default function TermsPage() {
  return (
    <I18nProvider>
      <LegalFrame en={<En />} zh={<Zh />} />
    </I18nProvider>
  )
}

function En() {
  return (
    <>
      <h1>Terms of Service</h1>
      <p className="legal-meta">
        Version 1.0 · Effective date: August 5, 2026 · Last updated: August 5, 2026
      </p>

      <p>
        These Terms of Service (&quot;Terms&quot;) govern your access to and use of Cassia
        (the &quot;Service&quot;), a cloud platform that gives AI agents a real, sandboxed
        computer to execute tasks on your behalf. The Service is operated by Cassia
        (&quot;we&quot;, &quot;us&quot;, &quot;our&quot;). By creating an account or using the
        Service, you agree to these Terms. If you do not agree, do not use the Service.
      </p>

      <h2>1. The Service</h2>
      <p>
        Cassia lets you run AI agents inside isolated cloud sandboxes and observe their
        execution in real time (terminal, screen, files). Usage of the Service is metered
        in credits, which can be purchased as one-time credit packs. New accounts receive a
        one-time grant of 100 free trial credits.
      </p>

      <h2>2. Accounts and eligibility</h2>
      <p>
        You must be at least 16 years old to use the Service. You sign in via a third-party
        identity provider (GitHub or Google). You are responsible for all activity under
        your account and for keeping your credentials secure.
      </p>

      <h2>3. Credits, pricing, and payment</h2>
      <p>
        The Service uses a prepaid credit system. 1 credit equals USD $0.01 of face value.
        Credits are deducted based on the compute cost of tasks you run, at the rates
        displayed in the product at the time of use. Credits are sold in one-time packs
        (e.g. 500 / 2,200 / 5,800 credits) at the prices shown at checkout.
      </p>
      <ul>
        <li>
          <strong>One-time purchase authorization.</strong> Each credit pack is a one-time,
          non-recurring purchase. By confirming a checkout you authorize a single charge of
          the displayed amount. We never charge you automatically or on a recurring basis.
        </li>
        <li>
          <strong>Payment processor.</strong> All payments are processed by our payment
          processor, <strong>Waffo Pancake</strong>, on a hosted checkout page. We never
          see or store your full card details.
        </li>
        <li>
          <strong>Credits validity.</strong> Purchased credits remain valid for
          12 months from the date of purchase. Trial credits remain valid while your
          account is active. Expired credits are forfeited without compensation.
        </li>
        <li>
          <strong>Consumed credits are non-refundable.</strong> Credits that have been
          deducted for tasks already executed are final and cannot be refunded or reversed.
        </li>
        <li>
          <strong>Refunds.</strong> Unused purchased credits may be refunded within
          7 days of the original purchase, upon request to the billing contact below.
          After 7 days, unused credits are not refundable except where required by law.
        </li>
        <li>
          <strong>Account termination.</strong> If your account is terminated (by you or by
          us for breach of these Terms), unused credits — including trial credits — are
          forfeited, except where a refund is required by applicable law.
        </li>
        <li>
          <strong>Duplicate or failed charges.</strong> If you believe you were charged
          twice or charged in error, contact the billing channel below with your order
          reference; verified duplicate charges will be refunded in full.
        </li>
      </ul>

      <h2>4. Acceptable use</h2>
      <p>You agree not to use the Service to:</p>
      <ul>
        <li>violate any applicable law or regulation;</li>
        <li>infringe intellectual-property or privacy rights of others;</li>
        <li>attack, probe, or disrupt networks, systems, or third parties;</li>
        <li>mine cryptocurrency, send spam, or run abusive workloads;</li>
        <li>attempt to escape or abuse the sandbox environment or underlying infrastructure.</li>
      </ul>
      <p>
        We may suspend or terminate accounts that breach these rules. A per-session usage
        cap applies to protect against runaway tasks; sessions that reach the cap are
        stopped automatically.
      </p>

      <h2>5. Your content and data</h2>
      <p>
        You retain ownership of the files and instructions you submit. Task execution data
        lives inside an ephemeral sandbox and may be deleted when the sandbox is reclaimed;
        we do not guarantee persistence of sandbox state. See our{' '}
        <Link href="/privacy">Privacy Policy</Link> for how we handle personal data.
      </p>

      <h2>6. Disclaimers and limitation of liability</h2>
      <p>
        The Service is provided &quot;as is&quot; and &quot;as available&quot;, without
        warranties of any kind. AI agents act autonomously inside sandboxes; you are
        responsible for reviewing their actions before relying on their output. To the
        maximum extent permitted by law, our aggregate liability arising from the Service
        is limited to the amount you paid us in the 12 months preceding the claim.
      </p>

      <h2>7. Changes to these Terms</h2>
      <p>
        We may update these Terms from time to time. Material changes will be announced on
        this page at least 14 days before they take effect, with the &quot;last
        updated&quot; date revised. Continued use after the effective date constitutes
        acceptance.
      </p>

      <h2>8. Contact</h2>
      <p>
        Cassia operates a single maintained contact channel for all inquiries — general
        support, billing, refund and duplicate-charge requests, cancellation, legal and
        privacy matters, and security reports:
      </p>
      <p>
        <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
      </p>
      <p>We aim to respond within 3 business days.</p>
    </>
  )
}

function Zh() {
  return (
    <>
      <h1>服务条款</h1>
      <p className="legal-meta">版本 1.0 · 生效日期：2026 年 8 月 5 日 · 最后更新：2026 年 8 月 5 日</p>

      <p>
        本服务条款（下称「条款」）约束你对 Cassia（下称「服务」）的访问与使用。Cassia
        是一个云平台，为 AI Agent 提供真实、隔离的沙箱电脑来代替你执行任务。服务由 Cassia
        （下称「我们」）运营。创建账户或使用服务即表示你同意本条款；如不同意，请勿使用。
      </p>

      <h2>1. 服务内容</h2>
      <p>
        Cassia 允许你在隔离的云端沙箱中运行 AI Agent，并实时观察其执行过程（终端、
        画面、文件）。服务按积分计量计费，积分通过一次性积分包购买。新账户可一次性获得
        100 免费试用积分。
      </p>

      <h2>2. 账户与资格</h2>
      <p>
        你必须年满 16 周岁方可使用本服务。登录通过第三方身份提供方（GitHub 或 Google）
        完成。你应对自己账户下的所有活动负责，并妥善保管登录凭证。
      </p>

      <h2>3. 积分、定价与支付</h2>
      <p>
        本服务采用预付费积分制。1 积分面值为 0.01 美元。积分根据你运行任务的实际算力
        成本按产品内展示的费率扣减。积分以一次性积分包形式出售（如 500 / 2,200 / 5,800
        积分），价格以收银台展示为准。
      </p>
      <ul>
        <li>
          <strong>一次性购买授权。</strong>每个积分包均为一次性、非周期性购买。确认收银台
          订单即表示你授权按展示金额进行单次扣款。我们不会自动续费或周期性扣款。
        </li>
        <li>
          <strong>支付处理方。</strong>所有支付均由我们的支付处理方 <strong>Waffo
          Pancake</strong> 在其托管收银台页面完成。我们从不查看或存储你的完整银行卡信息。
        </li>
        <li>
          <strong>积分有效期。</strong>已购积分自购买之日起 12 个月内有效；试用积分在账户
          存续期间有效。过期积分自动作废，不予补偿。
        </li>
        <li>
          <strong>已消耗积分不退。</strong>因已执行任务而扣减的积分为最终消费，不予退款或
          撤销。
        </li>
        <li>
          <strong>退款。</strong>未使用的已购积分可在原购买后 7 天内通过下方账单联系渠道
          申请退款。超过 7 天后，除法律另有规定外，未使用积分不予退款。
        </li>
        <li>
          <strong>账户终止。</strong>账户终止时（无论你主动注销或因违反条款被我们终止），
          未使用积分（含试用积分）将作废，法律要求退款的情形除外。
        </li>
        <li>
          <strong>重复或错误扣款。</strong>如你认为被重复扣款或扣款有误，请携带订单号联系
          下方账单渠道；经核实的重复扣款将全额退还。
        </li>
      </ul>

      <h2>4. 可接受使用</h2>
      <p>你同意不利用本服务：</p>
      <ul>
        <li>违反任何适用的法律法规；</li>
        <li>侵犯他人的知识产权或隐私权；</li>
        <li>攻击、探测或破坏网络、系统或第三方；</li>
        <li>挖矿、发送垃圾信息或运行其他滥用性负载；</li>
        <li>试图逃逸或滥用沙箱环境及底层基础设施。</li>
      </ul>
      <p>
        对违反上述规则的账户，我们可能暂停或终止服务。每个会话设有用量上限以防止任务
        失控，达到上限的会话将被自动停止。
      </p>

      <h2>5. 你的内容与数据</h2>
      <p>
        你提交的文件和指令的所有权归你所有。任务执行数据存在于临时沙箱中，沙箱回收后
        可能被删除；我们不保证沙箱状态的持久化。个人数据的处理方式见
        <Link href="/privacy">隐私政策</Link>。
      </p>

      <h2>6. 免责声明与责任限制</h2>
      <p>
        本服务按「现状」和「可用」状态提供，不作任何形式的担保。AI Agent 在沙箱内自主
        行动，依赖其输出前你应自行核查。在法律允许的最大范围内，我们就本服务承担的累计
        责任以你在索赔前 12 个月内实际支付的金额为限。
      </p>

      <h2>7. 条款变更</h2>
      <p>
        我们可能不时更新本条款。重大变更将在生效前至少 14 天在本页面公告，并更新
        「最后更新」日期。生效后继续使用即视为接受。
      </p>

      <h2>8. 联系方式</h2>
      <p>
        Cassia 为所有咨询提供统一且持续维护的联系渠道——包括一般支持、账单、退款与
        重复扣款请求、注销、法律与隐私事务以及安全问题报告：
      </p>
      <p>
        <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
      </p>
      <p>我们将在 3 个工作日内回复。</p>
    </>
  )
}
