import type { Metadata } from 'next'
import { I18nProvider } from '@/lib/i18n'
import { SUPPORT_EMAIL } from '@/lib/i18n'
import { LegalFrame } from '@/components/LegalFrame'

export const metadata: Metadata = {
  title: 'Privacy Policy — Cassia',
  description: 'Privacy Policy for Cassia, operated by Cassia',
}

export default function PrivacyPage() {
  return (
    <I18nProvider>
      <LegalFrame en={<En />} zh={<Zh />} />
    </I18nProvider>
  )
}

function En() {
  return (
    <>
      <h1>Privacy Policy</h1>
      <p className="legal-meta">
        Version 1.0 · Effective date: August 5, 2026 · Last updated: August 5, 2026
      </p>

      <p>
        This Privacy Policy explains how Cassia (the &quot;Service&quot;), operated by
        Cassia (the data controller, &quot;we&quot;, &quot;us&quot;), collects, uses,
        retains, and protects your personal data when you use the Service.
      </p>

      <h2>1. Data controller and contact</h2>
      <p>
        The data controller is Cassia, the individual operator of Cassia. For all
        privacy-related questions, requests, or complaints, contact us at{' '}
        <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>. We aim to respond within
        3 business days, and within 30 days for formal data-rights requests.
      </p>

      <h2>2. Data we collect</h2>
      <ul>
        <li>
          <strong>Account data.</strong> When you sign in via GitHub or Google (OAuth), we
          receive your user ID, name, and email address from the identity provider.
          Authentication is provided by InsForge.
        </li>
        <li>
          <strong>Usage and task data.</strong> The instructions you give agents, session
          metadata, event timelines, token-usage and cost records, and your credit wallet
          and ledger (purchases, deductions, balances).
        </li>
        <li>
          <strong>Sandbox content.</strong> Files you upload and files agents produce are
          stored inside an ephemeral cloud sandbox for the lifetime of that sandbox.
        </li>
        <li>
          <strong>Payment data.</strong> Payments are processed entirely by our payment
          processor, <strong>Waffo Pancake</strong>, on its hosted checkout page. We never
          see or store your full card number or security code; we receive only order
          confirmations (order ID, amount, status).
        </li>
        <li>
          <strong>Technical logs.</strong> Standard server logs (IP address, timestamps,
          errors) used for security and debugging.
        </li>
      </ul>

      <h2>3. How we use data</h2>
      <p>
        We use the data above to operate and secure the Service: authenticating you,
        executing your tasks, metering and billing credits, preventing abuse, and fixing
        bugs. We do not use your task content to train models. We do not run advertising
        or sell data.
      </p>

      <h2>4. No sale of personal data</h2>
      <p>
        We do not sell, rent, or trade your personal data to anyone, and we do not share
        it for cross-context behavioral advertising.
      </p>

      <h2>5. Third-party processors</h2>
      <ul>
        <li><strong>InsForge</strong> — authentication, database, and site hosting;</li>
        <li><strong>E2B</strong> — ephemeral sandbox compute where tasks run;</li>
        <li><strong>Waffo Pancake</strong> — payment processing;</li>
        <li><strong>LLM providers</strong> (e.g. DeepSeek) — your task instructions are sent to the model provider you configure, to produce agent output.</li>
      </ul>

      <h2>6. International transfers</h2>
      <p>
        Our infrastructure and processors are located in multiple jurisdictions (including
        Singapore and the United States). By using the Service, your data may be
        transferred to and processed in countries other than your own; we rely on our
        processors&apos; contractual safeguards for such transfers.
      </p>

      <h2>7. Retention</h2>
      <ul>
        <li>Account data: retained while your account is active; deleted within 30 days of account deletion.</li>
        <li>Session and event history: retained while your account is active, or until you delete the session.</li>
        <li>Sandbox content: deleted when the sandbox is reclaimed (typically within days of session end; dormant sandboxes may persist up to 30 days before cleanup).</li>
        <li>Payment and ledger records: retained for 7 years as required for accounting and tax purposes.</li>
        <li>Server logs: retained for up to 90 days.</li>
      </ul>

      <h2>8. Your rights</h2>
      <p>
        Where applicable law (including GDPR) grants them, you have the right to:
      </p>
      <ul>
        <li><strong>Access</strong> — obtain a copy of your personal data;</li>
        <li><strong>Rectification</strong> — correct inaccurate data;</li>
        <li><strong>Erasure</strong> — have your data deleted (&quot;right to be forgotten&quot;);</li>
        <li><strong>Restriction</strong> — limit how we process your data;</li>
        <li><strong>Portability</strong> — receive your data in a structured, machine-readable format;</li>
        <li><strong>Objection</strong> — object to processing based on legitimate interests;</li>
        <li><strong>Withdraw consent</strong> — where processing is based on consent, withdraw it at any time;</li>
        <li><strong>Lodge a complaint</strong> — with your local data-protection authority.</li>
      </ul>
      <p>
        To exercise any of these rights, email{' '}
        <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> from the address associated
        with your account. Deleting a session in the product deletes its sandbox and event
        history immediately and irreversibly.
      </p>

      <h2>9. Children</h2>
      <p>
        The Service is not directed at children. You must be at least 16 years old to use
        it, and we do not knowingly collect data from anyone under 16. If you believe a
        child under 16 has provided us data, contact us and we will delete it.
      </p>

      <h2>10. Security</h2>
      <p>
        We use TLS in transit, OAuth-based authentication, isolated per-task sandboxes,
        and row-level access control on user data. Report security issues to{' '}
        <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
      </p>

      <h2>11. Changes to this policy</h2>
      <p>
        We may update this policy from time to time. Material changes will be announced on
        this page at least 14 days before they take effect, with the &quot;last
        updated&quot; date revised. Continued use after the effective date constitutes
        acceptance.
      </p>
    </>
  )
}

function Zh() {
  return (
    <>
      <h1>隐私政策</h1>
      <p className="legal-meta">版本 1.0 · 生效日期：2026 年 8 月 5 日 · 最后更新：2026 年 8 月 5 日</p>

      <p>
        本隐私政策说明 Cassia（下称「服务」，由数据控制者 Cassia 运营，下称「我们」）
        在你使用服务时如何收集、使用、保留和保护你的个人数据。
      </p>

      <h2>1. 数据控制者与联系方式</h2>
      <p>
        数据控制者为 Cassia（Cassia 的个人运营者）。如有任何隐私相关的问题、请求或
        投诉，请联系 <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>。一般咨询
        我们将在 3 个工作日内回复；正式的数据权利请求将在 30 天内处理。
      </p>

      <h2>2. 我们收集的数据</h2>
      <ul>
        <li>
          <strong>账户数据。</strong>你通过 GitHub 或 Google（OAuth）登录时，我们从身份
          提供方接收你的用户 ID、姓名和邮箱地址。认证服务由 InsForge 提供。
        </li>
        <li>
          <strong>使用与任务数据。</strong>你向 Agent 发出的指令、会话元数据、事件时间线、
          token 用量与成本记录，以及你的积分钱包和流水（购买、扣减、余额）。
        </li>
        <li>
          <strong>沙箱内容。</strong>你上传的文件和 Agent 生成的文件保存在临时云沙箱中，
          生命周期与该沙箱一致。
        </li>
        <li>
          <strong>支付数据。</strong>支付完全由我们的支付处理方 <strong>Waffo Pancake</strong>
          在其托管收银台页面处理。我们从不查看或存储你的完整卡号或安全码，仅接收订单
          确认信息（订单号、金额、状态）。
        </li>
        <li>
          <strong>技术日志。</strong>用于安全和调试的标准服务器日志（IP 地址、时间戳、
          错误信息）。
        </li>
      </ul>

      <h2>3. 数据用途</h2>
      <p>
        我们使用上述数据来运营和保护服务：完成认证、执行你的任务、积分计量与计费、
        防止滥用以及修复缺陷。我们不会用你的任务内容训练模型，不投放广告，也不出售
        数据。
      </p>

      <h2>4. 不出售个人数据</h2>
      <p>
        我们不向任何人出售、出租或交易你的个人数据，也不会为跨场景行为广告目的共享
        数据。
      </p>

      <h2>5. 第三方处理方</h2>
      <ul>
        <li><strong>InsForge</strong> —— 认证、数据库与站点托管；</li>
        <li><strong>E2B</strong> —— 运行任务的临时沙箱算力；</li>
        <li><strong>Waffo Pancake</strong> —— 支付处理；</li>
        <li><strong>LLM 提供方</strong>（如 DeepSeek）—— 你的任务指令会发送给你所配置的模型提供方，用于生成 Agent 输出。</li>
      </ul>

      <h2>6. 跨境传输</h2>
      <p>
        我们的基础设施和处理方分布在多个司法辖区（包括新加坡和美国）。使用本服务即
        表示你的数据可能被传输到您所在国家/地区以外进行处理；我们依赖处理方的合同
        保障措施来约束此类传输。
      </p>

      <h2>7. 保留期限</h2>
      <ul>
        <li>账户数据：账户存续期间保留；账户注销后 30 天内删除。</li>
        <li>会话与事件历史：账户存续期间保留，或直到你删除该会话。</li>
        <li>沙箱内容：沙箱回收时删除（通常在会话结束后数天内；休眠沙箱最长保留 30 天后清理）。</li>
        <li>支付与账务记录：依法为会计和税务目的保留 7 年。</li>
        <li>服务器日志：最长保留 90 天。</li>
      </ul>

      <h2>8. 你的权利</h2>
      <p>在适用法律（包括 GDPR）授予的范围内，你享有以下权利：</p>
      <ul>
        <li><strong>访问权</strong> —— 获取你的个人数据副本；</li>
        <li><strong>更正权</strong> —— 更正不准确的数据；</li>
        <li><strong>删除权</strong> —— 要求删除你的数据（「被遗忘权」）；</li>
        <li><strong>限制处理权</strong> —— 限制我们处理你数据的方式；</li>
        <li><strong>可携带权</strong> —— 以结构化、机器可读的格式接收你的数据；</li>
        <li><strong>反对权</strong> —— 反对基于合法利益的数据处理；</li>
        <li><strong>撤回同意权</strong> —— 对基于同意的处理，可随时撤回；</li>
        <li><strong>投诉权</strong> —— 向你当地的数据保护机构投诉。</li>
      </ul>
      <p>
        如需行使上述任何权利，请使用与你账户关联的邮箱发送邮件至{' '}
        <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>。在产品内删除会话会立即
        且不可恢复地删除其沙箱和事件历史。
      </p>

      <h2>9. 未成年人</h2>
      <p>
        本服务不面向儿童。你必须年满 16 周岁方可使用，我们不会有意收集 16 周岁以下
        任何人的数据。如你认为有 16 周岁以下儿童向我们提供了数据，请联系我们，我们将
        予以删除。
      </p>

      <h2>10. 安全</h2>
      <p>
        我们采用传输层 TLS 加密、OAuth 认证、按任务隔离的沙箱以及用户数据的行级访问
        控制。安全问题请报告至 <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>。
      </p>

      <h2>11. 政策变更</h2>
      <p>
        我们可能不时更新本政策。重大变更将在生效前至少 14 天在本页面公告，并更新
        「最后更新」日期。生效后继续使用即视为接受。
      </p>
    </>
  )
}
