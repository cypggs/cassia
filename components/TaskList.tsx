'use client'

import { useState, type ReactNode } from 'react'
import type { SessionSummary } from '@cassia/shared'
import { LangToggle, useI18n } from '@/lib/i18n'
import { ThemeToggle } from '@/lib/theme'
import { SiteFooter } from '@/components/SiteFooter'

/** 左侧：任务列表 / 历史任务 */
export function TaskList({
  sessions,
  current,
  connected,
  onOpen,
  onNew,
  onRename,
  onPin,
  onDelete,
  user,
  onSignOut,
  balance,
  sessionCredits,
  onTopUp,
  onCollapse,
  gutter,
}: {
  sessions: SessionSummary[]
  current: string | null
  connected: boolean
  onOpen(id: string): void
  onNew(): void
  onRename(id: string, title: string): void
  onPin(id: string, pinned: boolean): void
  onDelete(id: string): void
  /** 登录用户信息（开放模式没有） */
  user?: { name?: string | null; image?: string | null }
  onSignOut?(): void
  /** 积分余额（undefined = 积分治理未启用，钱包 UI 不出现） */
  balance?: number
  /** 当前会话累计消耗（积分）；只有当前行显示 */
  sessionCredits?: number
  onTopUp?(): void
  /** 折叠侧边栏 */
  onCollapse?(): void
  /** 右缘分隔条（拖动改栏宽），由父级渲染传入 */
  gutter?: ReactNode
}) {
  const { t } = useI18n()
  /** 行内重命名中的会话 */
  const [editingId, setEditingId] = useState<string | null>(null)
  /** 待确认删除的会话（弹框） */
  const [confirming, setConfirming] = useState<SessionSummary | null>(null)

  const commitRename = (id: string, value: string) => {
    setEditingId(null)
    const title = value.trim()
    if (title) onRename(id, title)
  }

  return (
    <div className="panel tasks">
      <div className="panel-head">
        <span className="brand">
          Cassia
          <i className={connected ? 'led on' : 'led'} title={connected ? t('nav.connected') : t('nav.disconnected')} />
        </span>
        <span className="head-actions">
          {onCollapse && (
            <button className="side-toggle" onClick={onCollapse} title={t('nav.collapse')}>
              «
            </button>
          )}
          <ThemeToggle />
          <LangToggle />
          <button className="new" onClick={onNew}>
            {t('nav.newTask')}
          </button>
        </span>
      </div>
      <div className="panel-body list">
        {sessions.length === 0 && <p className="dim pad">{t('nav.empty')}</p>}
        {sessions.map((s) => (
          <div
            key={s.id}
            role="button"
            tabIndex={0}
            className={s.id === current ? 'task on' : 'task'}
            title={s.title}
            onClick={() => onOpen(s.id)}
            onKeyDown={(e) => e.key === 'Enter' && onOpen(s.id)}
          >
            <span className={`state ${s.agentStatus}`} />
            {editingId === s.id ? (
              <input
                className="task-edit"
                defaultValue={s.title}
                autoFocus
                onFocus={(e) => e.target.select()}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename(s.id, e.currentTarget.value)
                  if (e.key === 'Escape') setEditingId(null)
                }}
                onBlur={(e) => commitRename(s.id, e.target.value)}
              />
            ) : (
              <span className="task-title">
                {!!s.pinnedAt && <span className="task-pinned">📌</span>}
                {s.title}
                {s.id === current && !!sessionCredits && (
                  <span className="task-cost">
                    💎 {sessionCredits} {t('credits.sessionUsed')}
                  </span>
                )}
              </span>
            )}
            <span className="task-side">
              <span className="task-time">{fmt(s.updatedAt)}</span>
              <span className="task-actions" onClick={(e) => e.stopPropagation()}>
                <button
                  className={s.pinnedAt ? 'task-act pinned' : 'task-act'}
                  title={s.pinnedAt ? t('nav.unpin') : t('nav.pin')}
                  onClick={() => onPin(s.id, !s.pinnedAt)}
                >
                  📌
                </button>
                <button className="task-act" title={t('nav.rename')} onClick={() => setEditingId(s.id)}>
                  ✎
                </button>
                <button className="task-act danger" title={t('nav.delete')} onClick={() => setConfirming(s)}>
                  ×
                </button>
              </span>
            </span>
          </div>
        ))}
      </div>
      {(user || balance !== undefined) && (
        <div className="user-bar">
          {user && (
            <>
              {user.image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img className="user-avatar" src={user.image} alt="" referrerPolicy="no-referrer" />
              ) : (
                <span className="user-avatar user-avatar-fallback">{(user.name ?? '?')[0]}</span>
              )}
              <span className="user-name" title={user.name ?? ''}>
                {user.name}
              </span>
            </>
          )}
          {balance !== undefined && (
            <button
              className={`wallet-chip${balance <= 0 ? ' empty' : balance <= 50 ? ' low' : ''}`}
              onClick={onTopUp}
              title={t('credits.balanceTitle')}
            >
              💎 {balance}
            </button>
          )}
          {user && (
            <button className="user-signout" onClick={onSignOut} title={t('nav.signOut')}>
              {t('nav.signOut')}
            </button>
          )}
        </div>
      )}
      <SiteFooter />
      {gutter}

      {confirming && (
        <div className="modal-overlay" onClick={() => setConfirming(null)}>
          <div className="modal" role="alertdialog" onClick={(e) => e.stopPropagation()}>
            <h3>{t('delete.title')}</h3>
            <p className="modal-sub">{confirming.title}</p>
            <p className="dim">{t('delete.body')}</p>
            <div className="modal-actions">
              <button className="modal-cancel" onClick={() => setConfirming(null)}>
                {t('delete.cancel')}
              </button>
              <button
                className="modal-danger"
                autoFocus
                onClick={() => {
                  onDelete(confirming.id)
                  setConfirming(null)
                }}
              >
                {t('delete.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function fmt(ts: number): string {
  const d = new Date(ts)
  const now = Date.now()
  if (now - ts < 86_400_000) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  return `${d.getMonth() + 1}/${d.getDate()}`
}
