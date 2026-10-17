'use client'

import { useCallback, useEffect, useRef, useState, type ClipboardEvent } from 'react'
import type { UserSchema } from '@insforge/sdk'
import { useCassia, type Attachment } from '@/lib/useCassia'
import { AUTH_ENABLED, insforge } from '@/lib/commercial/insforge'
import { setSocketToken } from '@/lib/commercial/authToken'
import { I18nProvider, LangToggle, useI18n } from '@/lib/i18n'
import { ThemeToggle } from '@/lib/theme'
import { TaskList } from '@/components/TaskList'
import { Timeline } from '@/components/Timeline'
import { ComputerPanel } from '@/components/ComputerPanel'
import { RechargeModal } from '@/components/RechargeModal'
import { SiteFooter } from '@/components/SiteFooter'

/**
 * 开放模式（没配 InsForge env）直接进工作台，和鉴权引入前一样；
 * 启用后先过 AuthGate：OAuth 登录 → 取 accessToken → 工作台。
 */
export default function Page() {
  return (
    <I18nProvider>
      {AUTH_ENABLED ? <AuthGate /> : <Workspace />}
    </I18nProvider>
  )
}

function AuthGate() {
  const { t } = useI18n()
  const [user, setUser] = useState<UserSchema | null>(null)
  const [status, setStatus] = useState<'loading' | 'anon' | 'authed'>('loading')
  // 令牌过期后控制面会拒连，epoch+1 重挂载 Workspace 换新连接
  const [epoch, setEpoch] = useState(0)

  /**
   * 恢复/刷新会话。getCurrentUser 会自动等未完成的 OAuth 回调换票，
   * 也会用 httpOnly refresh cookie 恢复刷新后的登录态；拿到用户后再取
   * 一个 handshake 安全的 accessToken 交给控制面。
   */
  const loadSession = useCallback(async (): Promise<boolean> => {
    if (!insforge) return false
    const { data, error } = await insforge.auth.getCurrentUser()
    if (error || !data.user) return false
    const token = await insforge.getHttpClient().getValidAccessToken()
    if (!token) return false
    setSocketToken(token)
    setUser(data.user)
    return true
  }, [])

  useEffect(() => {
    void loadSession().then((ok) => setStatus(ok ? 'authed' : 'anon'))
  }, [loadSession])

  useEffect(() => {
    const onExpired = () =>
      void loadSession().then((ok) => {
        if (ok) setEpoch((n) => n + 1)
        else setStatus('anon')
      })
    window.addEventListener('cassia:unauthorized', onExpired)
    return () => window.removeEventListener('cassia:unauthorized', onExpired)
  }, [loadSession])

  if (status === 'loading') {
    return (
      <div className="login-page">
        <p className="dim">{t('login.loading')}</p>
      </div>
    )
  }
  if (status !== 'authed' || !user) return <Login />
  return (
    <Workspace
      key={epoch}
      user={{ name: user.profile?.name ?? user.email, image: user.profile?.avatar_url }}
      onSignOut={() => {
        setSocketToken(null)
        setUser(null)
        setStatus('anon')
        void insforge?.auth.signOut()
      }}
    />
  )
}

function Login() {
  const { t } = useI18n()
  const login = (provider: 'github' | 'google') => {
    // SDK 负责跳转；回来后 URL 带 insforge_code，getCurrentUser 自动换票
    void insforge?.auth.signInWithOAuth(provider, { redirectTo: window.location.origin })
  }
  return (
    <div className="login-page">
      <span className="login-lang">
        <ThemeToggle />
        <LangToggle />
      </span>
      <div className="login-card">
        <h1>Cassia</h1>
        <p className="dim">{t('login.tagline')}</p>
        <button className="login-btn" onClick={() => login('github')}>
          {t('login.github')}
        </button>
        <button className="login-btn" onClick={() => login('google')}>
          {t('login.google')}
        </button>
      </div>
      <SiteFooter />
    </div>
  )
}

interface PendingFile {
  id: number
  name: string
  size: number
  progress: number
  status: 'uploading' | 'done' | 'error'
  attachment?: Attachment
  error?: string
}

let nextFileId = 1

function Workspace({
  user,
  onSignOut,
}: {
  user?: { name?: string | null; image?: string | null }
  onSignOut?(): void
}) {
  const os = useCassia()
  const { t } = useI18n()
  const [draft, setDraft] = useState('')
  const [files, setFiles] = useState<PendingFile[]>([])
  const pickerRef = useRef<HTMLInputElement>(null)

  // ── 三栏布局：折叠态 + 两条可拖分隔条 ──
  // 列宽存在 .layout 的内联 CSS 变量里（--side-w / --right-w），
  // 默认值写在 globals.css，和改动前的比例完全一致；拖过才落 inline，
  // 双击分隔条 removeProperty 即还原。偏好持久化在 localStorage。
  const layoutRef = useRef<HTMLElement | null>(null)
  const [sideCollapsed, setSideCollapsed] = useState(false)

  useEffect(() => {
    const el = layoutRef.current
    if (!el) return
    try {
      const saved = JSON.parse(localStorage.getItem('cassia-layout') ?? '{}')
      if (saved.sideW) el.style.setProperty('--side-w', `${saved.sideW}px`)
      if (saved.rightW) el.style.setProperty('--right-w', `${saved.rightW}px`)
      if (saved.collapsed) setSideCollapsed(true)
    } catch { /* 没存过/存坏了就用默认布局 */ }
  }, [])

  const persistLayout = useCallback(() => {
    const el = layoutRef.current
    if (!el) return
    const num = (p: string) => parseInt(el.style.getPropertyValue(p)) || undefined
    try {
      localStorage.setItem('cassia-layout', JSON.stringify({
        sideW: num('--side-w'),
        rightW: num('--right-w'),
        collapsed: el.classList.contains('side-collapsed'),
      }))
    } catch { /* 隐私模式写不进就拉倒，布局照常工作 */ }
  }, [])

  const toggleSide = useCallback(() => {
    setSideCollapsed((v) => {
      const next = !v
      // 折叠/展开改变了中栏宽度 —— 终端要重新 fit
      requestAnimationFrame(() => window.dispatchEvent(new Event('resize')))
      return next
    })
  }, [])

  /** 分隔条拖动。which='side' 拖左栏右缘；'right' 拖中栏右缘（即右栏左缘） */
  const startDrag = useCallback((which: 'side' | 'right') => {
    return (e: React.PointerEvent<HTMLButtonElement>) => {
      if (which === 'side' && sideCollapsed) return
      e.preventDefault()
      const el = layoutRef.current
      if (!el) return
      const target = e.currentTarget
      const rect = el.getBoundingClientRect()
      const prop = which === 'side' ? '--side-w' : '--right-w'
      const min = which === 'side' ? 180 : 300
      const max = which === 'side' ? 480 : Math.round(rect.width * 0.75)
      el.classList.add('dragging')
      target.setPointerCapture(e.pointerId)
      let raf = 0
      let lastFit = 0
      const onMove = (ev: PointerEvent) => {
        const w = Math.round(which === 'side' ? ev.clientX - rect.left : rect.right - ev.clientX)
        const clamped = Math.min(max, Math.max(min, w))
        if (raf) cancelAnimationFrame(raf)
        raf = requestAnimationFrame(() => el.style.setProperty(prop, `${clamped}px`))
        // xterm 的 fit 跟着 window resize 走 —— 拖动中节流触发
        const now = Date.now()
        if (now - lastFit > 120) {
          lastFit = now
          window.dispatchEvent(new Event('resize'))
        }
      }
      const onUp = () => {
        target.removeEventListener('pointermove', onMove)
        target.removeEventListener('pointerup', onUp)
        target.removeEventListener('pointercancel', onUp)
        if (raf) cancelAnimationFrame(raf)
        el.classList.remove('dragging')
        window.dispatchEvent(new Event('resize'))
        persistLayout()
      }
      target.addEventListener('pointermove', onMove)
      target.addEventListener('pointerup', onUp)
      target.addEventListener('pointercancel', onUp)
    }
  }, [sideCollapsed, persistLayout])

  /** 双击分隔条 → 该列恢复默认宽度 */
  const resetDrag = useCallback((which: 'side' | 'right') => {
    return () => {
      layoutRef.current?.style.removeProperty(which === 'side' ? '--side-w' : '--right-w')
      window.dispatchEvent(new Event('resize'))
      persistLayout()
    }
  }, [persistLayout])

  /** 键盘可调（role=separator）：←→ 每次 16px，Home 还原 */
  const nudgeDrag = useCallback((which: 'side' | 'right') => {
    return (e: React.KeyboardEvent<HTMLButtonElement>) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home') return
      e.preventDefault()
      const el = layoutRef.current
      if (!el || (which === 'side' && sideCollapsed)) return
      const prop = which === 'side' ? '--side-w' : '--right-w'
      if (e.key === 'Home') {
        el.style.removeProperty(prop)
      } else {
        const panel = el.children[which === 'side' ? 0 : 2]
        const cur = Math.round(panel.getBoundingClientRect().width)
        const delta = (e.key === 'ArrowRight') === (which === 'side') ? 16 : -16
        const min = which === 'side' ? 180 : 300
        const max = which === 'side' ? 480 : Math.round(el.getBoundingClientRect().width * 0.75)
        el.style.setProperty(prop, `${Math.min(max, Math.max(min, cur + delta))}px`)
      }
      window.dispatchEvent(new Event('resize'))
      persistLayout()
    }
  }, [sideCollapsed, persistLayout])
  /** 支付跳回的提示（?checkout=success） */
  const [checkoutToast, setCheckoutToast] = useState(false)
  /** 会话加载失败提示（join ack null —— 后端抖动时不再无声卡住） */
  const [loadErrorToast, setLoadErrorToast] = useState(false)

  useEffect(() => {
    if (!os.loadError) return
    setLoadErrorToast(true)
    const timer = setTimeout(() => setLoadErrorToast(false), 5000)
    return () => clearTimeout(timer)
  }, [os.loadError])

  // 托管收银台支付成功后跳回首页带 ?checkout=success —— 提示一句然后抹掉参数；
  // 积分到账靠 webhook → wallet_update 推送，不在这里轮询
  useEffect(() => {
    if (!window.location.search.includes('checkout=success')) return
    setCheckoutToast(true)
    window.history.replaceState(null, '', window.location.pathname)
    const timer = setTimeout(() => setCheckoutToast(false), 6000)
    return () => clearTimeout(timer)
  }, [])

  const running = os.status === 'running'
  const readyAttachments = files.filter((f) => f.status === 'done' && f.attachment)
  const uploading = files.some((f) => f.status === 'uploading')

  function pick(selected: FileList | File[] | null) {
    if (!selected?.length) return
    for (const raw of Array.from(selected)) {
      const file = withMeaningfulName(raw)
      const id = nextFileId++
      setFiles((prev) => [...prev, { id, name: file.name, size: file.size, progress: 0, status: 'uploading' }])
      os.upload(file, (pct) =>
        setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, progress: pct } : f))),
      ).then(
        (attachment) =>
          setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, status: 'done', progress: 100, attachment } : f))),
        (e: Error) =>
          setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, status: 'error', error: e.message } : f))),
      )
    }
  }

  /** 粘贴板里的图名字都是 image.png，重了谁也分不清 —— 按时间戳起个名 */
  function withMeaningfulName(file: File): File {
    if (file.name && !/^(image|blob|file)(\.|$)/i.test(file.name)) return file
    const ext = file.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png'
    const ts = new Date().toLocaleString('zh-CN', { hour12: false }).replace(/[/: ]/g, '-')
    return new File([file], `${t('composer.pastedName')}-${ts}.${ext}`, { type: file.type })
  }

  /** 剪贴板有文件（截图/复制的图）时直接进上传队列；纯文本粘贴不受影响 */
  function onPaste(e: ClipboardEvent) {
    const pasted = Array.from(e.clipboardData?.files ?? [])
    if (!pasted.length) return
    e.preventDefault()
    pick(pasted)
  }

  function submit() {
    // 只有附件没有文字时，替用户说一句 —— 气泡和 prompt 都用它，不说悄悄话
    const text = draft.trim() || (readyAttachments.length ? t('composer.autoText') : '')
    if (!text || uploading) return
    const attachments = readyAttachments.map((f) => f.attachment!)
    // 任务跑着的时候发消息 = 插话干预，不是新任务；没有会话时 send 会自己建
    if (running) os.steer(text, attachments)
    else os.send(text, attachments)
    setDraft('')
    setFiles([])
  }

  return (
    <main
      ref={layoutRef}
      className={sideCollapsed ? 'layout side-collapsed' : 'layout'}
    >
      <TaskList
        sessions={os.sessions}
        current={os.sessionId}
        connected={os.connected}
        onOpen={os.openSession}
        onNew={os.newSession}
        onRename={os.renameSession}
        onPin={os.togglePin}
        onDelete={os.deleteSession}
        user={user}
        onSignOut={onSignOut}
        balance={os.wallet?.balance}
        sessionCredits={os.sessionCredits}
        onTopUp={() => os.setRechargeOpen(true)}
        onCollapse={toggleSide}
        gutter={
          <button
            className="gutter"
            aria-label={t('nav.collapse')}
            role="separator"
            aria-orientation="vertical"
            onPointerDown={startDrag('side')}
            onDoubleClick={resetDrag('side')}
            onKeyDown={nudgeDrag('side')}
          />
        }
      />

      {sideCollapsed && (
        <button className="side-expand" onClick={toggleSide} title={t('nav.expand')}>
          »
        </button>
      )}

      <div className="panel center">
        <div className="panel-body">
          <Timeline events={os.events} sessionId={os.sessionId} />
        </div>
        <div className="composer">
          {files.length > 0 && (
            <div className="chips">
              {files.map((f) => (
                <span className={`chip ${f.status}`} key={f.id} title={f.error ?? f.name}>
                  {f.status === 'uploading' && <span className="chip-spin" />}
                  {f.name}
                  {f.status === 'uploading' && <span className="dim"> {f.progress}%</span>}
                  {f.status === 'error' && <span className="chip-err"> {t('composer.failed')}</span>}
                  <button
                    className="chip-x"
                    onClick={() => setFiles((prev) => prev.filter((x) => x.id !== f.id))}
                    title={t('composer.remove')}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          <textarea
            value={draft}
            placeholder={
              running ? t('composer.steerPlaceholder') : t('composer.goalPlaceholder')
            }
            onChange={(e) => setDraft(e.target.value)}
            onPaste={onPaste}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit()
              }
            }}
          />
          <div className="composer-actions">
            <input
              ref={pickerRef}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                pick(e.target.files)
                e.target.value = ''
              }}
            />
            <button
              className="attach"
              onClick={() => pickerRef.current?.click()}
              disabled={!os.sessionId}
              title={t('composer.attachTitle')}
            >
              📎
            </button>
            {running && (
              <button className="ghost" onClick={os.abort}>
                {t('composer.stop')}
              </button>
            )}
            <button
              className="send"
              onClick={submit}
              disabled={uploading || (!draft.trim() && !readyAttachments.length)}
            >
              {running ? t('composer.steer') : t('composer.send')}
            </button>
          </div>
        </div>
        <button
          className="gutter"
          aria-label="Resize panels"
          role="separator"
          aria-orientation="vertical"
          onPointerDown={startDrag('right')}
          onDoubleClick={resetDrag('right')}
          onKeyDown={nudgeDrag('right')}
        />
      </div>

      <ComputerPanel
        events={os.events}
        sessionId={os.sessionId}
        subscribeConsole={os.subscribeConsole}
        consoleStart={os.consoleStart}
        consoleInput={os.consoleInput}
        consoleResize={os.consoleResize}
        consoleClose={os.consoleClose}
      />

      {checkoutToast && <div className="toast">{t('recharge.successToast')}</div>}
      {loadErrorToast && <div className="toast">{t('error.loadSession')}</div>}
      {os.wallet && (
        <RechargeModal
          wallet={os.wallet}
          open={os.rechargeOpen}
          onClose={() => os.setRechargeOpen(false)}
          createCheckout={os.createCheckout}
        />
      )}
    </main>
  )
}
