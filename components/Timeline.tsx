'use client'

import { memo, useEffect, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { AgentEvent, PlanTask, PlanUpdateEvent, ToolUsedEvent } from '@cassia/shared'
import { downloadSessionFile } from '@/lib/commercial/authToken'
import { useI18n } from '@/lib/i18n'

/**
 * 中间栏：任务执行过程。
 *
 * 这里只读 `toolUsed.message`（人话），不碰 `detail`（原始数据，那是右侧的事）。
 * 双表示的价值就在这 —— 中间栏不需要知道终端输出长什么样。
 *
 * 同一个 actionId 的多条事件折叠成一行，状态原地变化，
 * 否则一个跑 30 秒的命令会刷出几十条重复气泡。
 */
export function Timeline({ events, sessionId }: { events: AgentEvent[]; sessionId: string | null }) {
  const { t } = useI18n()
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [events.length])

  const rows = collapse(events)
  const live = lastLiveStatus(events)
  const plan = lastPlan(events)

  return (
    <div className="timeline">
      {plan && <PlanCard plan={plan} planLabel={t('timeline.plan')} />}
      {rows.length === 0 && (
        <div className="empty">
          <h2>{t('timeline.emptyTitle')}</h2>
          <p className="dim">{t('timeline.emptyBody')}</p>
        </div>
      )}

      {rows.map((e) => {
        if (e.type === 'chat') {
          return (
            <div key={e.id} className={e.sender === 'user' ? 'row user' : 'row assistant'}>
              <div className="bubble">
                {e.sender === 'user' ? (
                  e.content
                ) : (
                  <AssistantMarkdown content={e.content} />
                )}
                {e.attachments?.length ? (
                  <span className="bubble-files">
                    {e.attachments.map((a) => (
                      <a
                        key={a.path}
                        className="bubble-file"
                        href="#"
                        onClick={(ev) => {
                          ev.preventDefault()
                          if (sessionId) void downloadSessionFile(sessionId, a.path)
                        }}
                        title={`${a.path} (${fmtSize(a.size)}) — ${t('files.download')}`}
                      >
                        📎 {a.name}
                      </a>
                    ))}
                  </span>
                ) : null}
              </div>
            </div>
          )
        }
        if (e.type === 'toolUsed') return <ToolRow key={e.actionId} e={e} t={t} />
        // 每轮成本：小灰字。积分是服务端扣费那一刻的快照，展示不做二次换算
        if (e.type === 'usageReport') {
          if (e.credits == null) return null
          return (
            <div key={e.id} className="row cost">
              💎 {t('credits.turnUsed')} {e.credits} {t('credits.credits')}
              <span className="dim">
                {' '}(${e.costUsd.toFixed(4)}
                {e.model ? ` · ${e.model.split('/').pop()}` : ''})
              </span>
            </div>
          )
        }
        if (e.type === 'statusUpdate' && (e.brief || e.code) && !e.noRender) {
          // 积分类事件文案以本地语言为准（服务端 brief 只是兜底）
          const brief =
            e.code === 'insufficient_credits'
              ? t('credits.insufficientBrief')
              : e.code === 'session_budget_cap'
                ? t('credits.budgetCapBrief')
                : e.brief
          return (
            <div key={e.id} className={`row status ${e.agentStatus}`}>
              <span>{brief}</span>
              {!e.code && e.description && <span className="dim"> — {e.description}</span>}
            </div>
          )
        }
        return null
      })}

      {live && (
        <div className="row live">
          <span className="pulse" />
          {live}
        </div>
      )}
      <div ref={endRef} />
    </div>
  )
}

/**
 * assistant 气泡的 Markdown。memo 按 content 跳过老消息的重复解析 ——
 * 流式期间每条新事件都会重渲染时间线，没有它几百条历史气泡每次都要重新 parse。
 * react-markdown 默认不渲染原始 HTML，注入安全；GFM 补表格/删除线/任务列表。
 */
const AssistantMarkdown = memo(function AssistantMarkdown({ content }: { content: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  )
})

function ToolRow({ e, t }: { e: ToolUsedEvent; t: ReturnType<typeof useI18n>['t'] }) {
  const icon = { terminal: '▸', textEditor: '✎', browser: '◍', search: '⌕', other: '·' }[e.tool]
  return (
    <div className={`row tool ${e.status}`}>
      <span className="tool-icon">{icon}</span>
      <span className="tool-action">{e.message.action}</span>
      {e.message.param && <code className="tool-param">{e.message.param}</code>}
      <span className="tool-status">
        {e.status === 'running' ? t('timeline.running') : e.status === 'error' ? t('timeline.failed') : ''}
      </span>
    </div>
  )
}

/**
 * 折叠：toolUsed 按 actionId 取最后一条；其余按 id 去重。
 * 事件流本身允许重复投递，折叠放在渲染层做，存储层保持纯追加。
 */
function collapse(events: AgentEvent[]): AgentEvent[] {
  const out: AgentEvent[] = []
  const toolIndex = new Map<string, number>()
  const seen = new Set<string>()

  for (const e of events) {
    if (e.type === 'liveStatus') continue
    if (e.type === 'sandboxUpdate') continue
    // 计划走顶部的常驻卡片，不在消息流里留快照尸体
    if (e.type === 'planUpdate') continue
    if (e.type === 'newPlanStep') continue
    if (e.type === 'toolUsed') {
      const i = toolIndex.get(e.actionId)
      if (i !== undefined) out[i] = e
      else {
        toolIndex.set(e.actionId, out.length)
        out.push(e)
      }
      continue
    }
    if (seen.has(e.id)) continue
    seen.add(e.id)
    out.push(e)
  }
  return out
}

function lastLiveStatus(events: AgentEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.type === 'liveStatus') return e.text
    if (e.type === 'statusUpdate' && e.agentStatus !== 'running') return null
  }
  return null
}

/** planUpdate 是全量快照 —— 面板只关心最新一份 */
function lastPlan(events: AgentEvent[]): PlanUpdateEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.type === 'planUpdate') return e
  }
  return undefined
}

const PLAN_ICON: Record<PlanTask['status'], string> = {
  todo: '○',
  doing: '◐',
  done: '●',
  failed: '✕',
}

/**
 * 计划卡片：常驻时间线顶部（sticky），随 planUpdate 原地刷新。
 * 这是「任务进度」心智的落点 —— 用户一眼看到整体走到哪了，
 * 不用在工具流里翻。
 */
function PlanCard({ plan, planLabel }: { plan: PlanUpdateEvent; planLabel: string }) {
  const done = plan.tasks.filter((t) => t.status === 'done').length
  const total = plan.tasks.length
  const failed = plan.tasks.some((t) => t.status === 'failed')
  return (
    <div className={`plan-card${failed ? ' has-failed' : ''}`}>
      <div className="plan-card-head">
        <span>{planLabel}</span>
        <span className="dim">
          {done}/{total}
        </span>
      </div>
      <div className="plan-bar">
        <div className="plan-bar-fill" style={{ width: `${(done / total) * 100}%` }} />
      </div>
      <ul className="plan-list">
        {plan.tasks.map((t, i) => (
          <li key={i} className={`plan-item ${t.status}`}>
            <span className="plan-ico">{PLAN_ICON[t.status]}</span>
            {t.title}
          </li>
        ))}
      </ul>
    </div>
  )
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}
