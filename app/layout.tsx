import type { Metadata } from 'next'
import '@xterm/xterm/css/xterm.css'
import './globals.css'

export const metadata: Metadata = {
  title: 'Cassia',
  description: 'A real computer for your agent',
  // Waffo 商户域名所有权验证（正式环境审核要求挂在首页 head）
  other: { 'waffo-verify': 'bced060f6cc5032824a59c2ce7c77cf6' },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // lang 默认 en；客户端 I18nProvider 挂载后会按用户选择修正
  return (
    <html lang="en">
      <body>
        {/* 首帧前还原显式主题选择（light/dark）；system = 无属性，CSS 媒体查询接管 */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem('cassia-theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}`,
          }}
        />
        {children}
      </body>
    </html>
  )
}
