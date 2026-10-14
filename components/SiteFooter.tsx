'use client'

import Link from 'next/link'
import { useI18n, SUPPORT_EMAIL } from '@/lib/i18n'

/**
 * 全站页脚：定价 / 服务条款 / 隐私政策。
 * Waffo 商户审核要求访客在任何页面都能找到这些入口 ——
 * 登录页、工作台左侧栏底部、法律页都挂它。
 */
export function SiteFooter() {
  const { t } = useI18n()
  return (
    <footer className="site-footer">
      <Link href="/pricing">{t('footer.pricing')}</Link>
      <Link href="/terms">{t('footer.terms')}</Link>
      <Link href="/privacy">{t('footer.privacy')}</Link>
      <a href={`mailto:${SUPPORT_EMAIL}`}>{t('footer.support')}: {SUPPORT_EMAIL}</a>
      <span className="dim">© 2026 Cassia</span>
    </footer>
  )
}
