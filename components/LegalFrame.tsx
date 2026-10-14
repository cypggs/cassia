'use client'

import Link from 'next/link'
import type { ReactNode } from 'react'
import { LangToggle, useI18n } from '@/lib/i18n'
import { ThemeToggle } from '@/lib/theme'
import { SiteFooter } from '@/components/SiteFooter'

/**
 * 法律/定价页的统一外壳：中英双语 + 语言切换 + 全站页脚。
 * SSR 恒为英文（waffo 审核看到英文原文），挂载后按 localStorage 修正 ——
 * 与主应用的 i18n 模式一致。en/zh 都是 JSX，富文本不进字典。
 */
export function LegalFrame({ en, zh }: { en: ReactNode; zh: ReactNode }) {
  const { lang } = useI18n()
  return (
    <main className="legal">
      <div className="legal-body">
        <div className="legal-top">
          <Link href="/" className="legal-home">← Cassia</Link>
          <span className="legal-toggles">
            <ThemeToggle />
            <LangToggle />
          </span>
        </div>
        {lang === 'zh' ? zh : en}
        <SiteFooter />
      </div>
    </main>
  )
}
