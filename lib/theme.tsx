'use client'

import { useEffect, useState } from 'react'
import { useI18n, type I18nKey } from './i18n'

/**
 * 主题三态：system（默认，跟随 OS）→ light → dark → system。
 * system 的实现是「不写 data-theme 属性」—— CSS 里 :root 默认深色，
 * @media (prefers-color-scheme: light) + html:not([data-theme]) 给浅色。
 * 选择存 localStorage('cassia-theme')，layout 里的内联脚本在首帧前还原。
 */
export type Theme = 'system' | 'light' | 'dark'

const ORDER: Theme[] = ['system', 'light', 'dark']
const ICON: Record<Theme, string> = { system: '🖥', light: '☀️', dark: '🌙' }
const LABEL: Record<Theme, I18nKey> = {
  system: 'theme.system',
  light: 'theme.light',
  dark: 'theme.dark',
}

export function ThemeToggle() {
  const { t } = useI18n()
  // SSR 与首渲染恒为 system（和内联脚本前的默认一致），挂载后修正
  const [theme, setTheme] = useState<Theme>('system')

  useEffect(() => {
    const saved = localStorage.getItem('cassia-theme')
    if (saved === 'light' || saved === 'dark') setTheme(saved)
  }, [])

  const cycle = () => {
    const next = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length]
    setTheme(next)
    if (next === 'system') {
      localStorage.removeItem('cassia-theme')
      delete document.documentElement.dataset.theme
    } else {
      localStorage.setItem('cassia-theme', next)
      document.documentElement.dataset.theme = next
    }
  }

  return (
    <button
      className="lang-toggle"
      onClick={cycle}
      title={t(LABEL[theme])}
      aria-label={t(LABEL[theme])}
    >
      {ICON[theme]}
    </button>
  )
}
