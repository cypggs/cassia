'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentEvent, SandboxUpdateEvent, TerminalDetail, TextEditorDetail, ToolUsedEvent } from '@cassia/shared'
import { SOCKET_URL } from '@/lib/useCassia'
import { authHeaders, downloadSessionFile } from '@/lib/authToken'
import { useI18n, type I18nKey } from '@/lib/i18n'

/**
 * 右侧：Agent 的计算环境。
 *
 * 终端不是「把日志排版成终端的样子」，而是把 runtime 送来的字节流原样喂进
 * xterm.js —— 事件里的 ANSI 转义序列是保留的，颜色、光标、进度条都能正常工作。
 * 这是「真终端」和「假终端」的分界线。
 *
 * 画面 tab 用 sandboxUpdate 里的 vncUrl 直连沙箱，不经控制面中转。
 * 画面排第一个：看到 Agent 亲手操作浏览器是这个产品最直观的情绪价值。
 */

type Tab = 'screen' | 'terminal' | 'files'

export function ComputerPanel({ events, sessionId }: { events: AgentEvent[]; sessionId: string | null }) {
  const { t } = useI18n()
  const [tab, setTab] = useState<Tab>('screen')
  const sandbox = lastSandboxUpdate(events)

  return (
    <div className="panel computer">
      <div className="panel-head">
        <div className="tabs">
          <button className={tab === 'screen' ? 'tab on' : 'tab'} onClick={() => setTab('screen')}>
            {t('tab.screen')}
          </button>
          <button className={tab === 'terminal' ? 'tab on' : 'tab'} onClick={() => setTab('terminal')}>
            {t('tab.terminal')}
          </button>
          <button className={tab === 'files' ? 'tab on' : 'tab'} onClick={() => setTab('files')}>
            {t('tab.files')}
          </button>
        </div>
        {sandbox && (
          <span className="sandbox-id" title={t('screen.sandboxId')}>
            {sandbox.sandboxId}
          </span>
        )}
      </div>

      {/*
        视图都常驻，只切显隐 —— 不能用条件渲染换掉其中一个。
        换掉的代价有两处，都很实：终端那边，xterm 是异步 import 的，
        重建时 events 往往已经不再变化，写入 effect 再也不触发，
        用户切回来看到的是空白；画面那边，每切一次 tab 就把 VNC
        连接拆了重连，几秒黑屏。
      */}
      <div className="panel-body">
        <div className={tab === 'screen' ? 'view' : 'view off'}>
          <ScreenView vncUrl={sandbox?.vncUrl} status={sandbox?.status} />
        </div>
        <div className={tab === 'terminal' ? 'view' : 'view off'}>
          <TerminalView events={events} sessionId={sessionId} active={tab === 'terminal'} />
        </div>
        <div className={tab === 'files' ? 'view' : 'view off'}>
          <FilesView events={events} sessionId={sessionId} />
        </div>
      </div>
    </div>
  )
}

function lastSandboxUpdate(events: AgentEvent[]) {
  // 状态取最新一条，但 vncUrl/webRTCUrl 要取「最后一条带地址的」——
  // 沙箱暂停时发的 sandboxUpdate 只有状态没有地址（paused 的机器没有
  // 可连的端口），直接用最新一条会把地址冲掉，画面面板误显示
  // 「本次运行没有图形环境」（线上踩过）。
  let latest: SandboxUpdateEvent | undefined
  let withUrls: SandboxUpdateEvent | undefined
  for (let i = events.length - 1; i >= 0 && (!latest || !withUrls); i--) {
    const e = events[i]
    if (e.type !== 'sandboxUpdate') continue
    if (!latest) latest = e
    if (!withUrls && (e.vncUrl || e.webRTCUrl)) withUrls = e
  }
  if (!latest) return undefined
  return { ...latest, vncUrl: withUrls?.vncUrl, webRTCUrl: withUrls?.webRTCUrl }
}

function TerminalView({
  events,
  sessionId,
  active,
}: {
  events: AgentEvent[]
  sessionId: string | null
  active: boolean
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<{ write(s: string): void; reset(): void; dispose(): void } | null>(null)
  const fitRef = useRef<{ fit(): void } | null>(null)
  /**
   * xterm 是异步 import 的，就绪与否必须是 state 不能只是 ref ——
   * 用 ref 的话，events 在终端就绪前就到齐的情况下不会有任何东西触发重渲染，
   * 那批事件就永远写不进去了。
   */
  const [ready, setReady] = useState(false)
  /** 已写入终端的事件 id —— 事件会因 upsert 重放，写过的不能再写 */
  const writtenRef = useRef(new Set<string>())
  /** 已回显过命令行的 actionId */
  const echoedRef = useRef(new Set<string>())
  const { t } = useI18n()

  useEffect(() => {
    let disposed = false
    let fit: { fit(): void } | null = null

    ;(async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
      ])
      if (disposed || !hostRef.current) return

      const term = new Terminal({
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 12.5,
        lineHeight: 1.35,
        convertEol: true,
        cursorBlink: false,
        theme: {
          background: '#0e1116',
          foreground: '#c9d1d9',
          selectionBackground: '#264f78',
        },
      })
      const fitAddon = new FitAddon()
      term.loadAddon(fitAddon)
      term.open(hostRef.current)
      fitAddon.fit()
      fit = fitAddon
      fitRef.current = fitAddon
      termRef.current = term as unknown as typeof termRef.current
      term.write(`\x1b[90m${t('terminal.waiting')}\x1b[0m\r\n`)
      setReady(true)
    })()

    const onResize = () => fit?.fit()
    window.addEventListener('resize', onResize)
    return () => {
      disposed = true
      window.removeEventListener('resize', onResize)
      termRef.current?.dispose()
      termRef.current = null
      fitRef.current = null
    }
    // 提示语只在终端初建时写一次，语言切换不回溯（它已是终端历史的一行）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 隐藏时容器尺寸是 0，那会儿 fit() 会把终端算成 0 列。
  // 等它重新可见了再量一次。
  useEffect(() => {
    if (active) fitRef.current?.fit()
  }, [active])

  // 切换会话 → 清屏重来
  useEffect(() => {
    writtenRef.current.clear()
    echoedRef.current.clear()
    termRef.current?.reset()
  }, [sessionId])

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    for (const e of events) {
      if (e.type !== 'toolUsed') continue
      const t = terminalDetail(e)
      if (!t) continue
      if (writtenRef.current.has(e.id)) continue
      writtenRef.current.add(e.id)

      // pi 不给提示符，这里补一个，让命令和输出在视觉上分得开
      if (t.command && !echoedRef.current.has(e.actionId)) {
        echoedRef.current.add(e.actionId)
        term.write(`\x1b[32mubuntu@sandbox\x1b[0m:\x1b[34m~\x1b[0m$ ${t.command}\r\n`)
      }
      for (const chunk of t.output) term.write(chunk)
      if (t.finished) term.write('\r\n')
    }
  }, [events, ready])

  return <div className="term-host" ref={hostRef} />
}

function terminalDetail(e: ToolUsedEvent): TerminalDetail | null {
  const d = e.detail
  if (d && 'terminal' in d) return d.terminal
  return null
}

type ScreenState = 'connecting' | 'connected' | 'disconnected'

/**
 * 画面：noVNC 直连沙箱的 websockify，**不经控制面**。
 *
 * 默认只看不操作。Agent 在干活的时候，用户的一次误点可能把它带偏，
 * 而且很难看出是自己点的还是 Agent 点的。要接管得显式按一下 ——
 * 这一下也是「这台电脑是 Agent 的，但我随时能拿回来」这个心智模型的落点。
 */
function ScreenView({ vncUrl, status }: { vncUrl?: string; status?: string }) {
  const { t } = useI18n()
  const hostRef = useRef<HTMLDivElement>(null)
  const rfbRef = useRef<{ viewOnly: boolean; disconnect(): void; focus(): void } | null>(null)
  const [state, setState] = useState<ScreenState>('connecting')
  const [takeover, setTakeover] = useState(false)
  /** 重连次数，用来做退避；连上就清零 */
  const retryRef = useRef(0)

  useEffect(() => {
    if (!vncUrl) return
    // 沙箱休眠后 VNC 一定会断，这是预期 —— 不必再立刻重连打醒它，
    // 等 status 回到 running（唤醒完成）再连
    if (status === 'paused') return
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const connect = async () => {
      if (disposed || !hostRef.current) return
      setState('connecting')
      const { default: RFB } = await import('@novnc/novnc')
      if (disposed || !hostRef.current) return

      const rfb = new RFB(hostRef.current, vncUrl, { shared: true })
      rfb.scaleViewport = true
      // 沙箱是固定分辨率（SCREEN_GEOMETRY）。让远端跟着浏览器窗口改分辨率，
      // 会把 Agent 脚本里写死的坐标全部打乱。
      rfb.resizeSession = false
      rfb.viewOnly = true
      rfb.background = '#0e1116'
      rfbRef.current = rfb

      rfb.addEventListener('connect', () => {
        retryRef.current = 0
        setState('connected')
      })
      rfb.addEventListener('disconnect', () => {
        if (disposed) return
        setState('disconnected')
        rfbRef.current = null
        // 沙箱冷启动时 websockify 可能还没起来，重连是正常路径不是异常
        const delay = Math.min(1000 * 2 ** retryRef.current++, 10_000)
        timer = setTimeout(connect, delay)
      })
    }

    void connect()
    return () => {
      disposed = true
      if (timer) clearTimeout(timer)
      rfbRef.current?.disconnect()
      rfbRef.current = null
    }
  }, [vncUrl, status])

  // 接管状态单独同步：切换它不该把连接拆掉重连
  useEffect(() => {
    if (!rfbRef.current) return
    rfbRef.current.viewOnly = !takeover
    if (takeover) rfbRef.current.focus()
  }, [takeover, state])

  if (!vncUrl) {
    return (
      <div className="empty">
        <p>{t('screen.emptyTitle')}</p>
        <p className="dim">{t('screen.emptyBody')}</p>
      </div>
    )
  }

  return (
    <div className="screen-wrap">
      <div className="screen-bar">
        <span className={`dot ${status === 'paused' ? 'paused' : state}`} />
        <span className="dim">
          {status === 'paused'
            ? t('screen.paused')
            : state === 'connected'
              ? t('screen.connected')
              : state === 'connecting'
                ? t('screen.connecting')
                : t('screen.reconnecting')}
        </span>
        <button
          className={takeover ? 'takeover on' : 'takeover'}
          onClick={() => setTakeover((v) => !v)}
          disabled={state !== 'connected'}
          title={takeover ? t('screen.releaseTitle') : t('screen.takeoverTitle')}
        >
          {takeover ? t('screen.release') : t('screen.takeover')}
        </button>
      </div>
      <div className="screen-host" ref={hostRef} />
    </div>
  )
}

// ── 文件 ────────────────────────────────────────────────────────────

interface FileOp {
  action: TextEditorDetail['action']
  ts: number
  status: ToolUsedEvent['status']
  content?: string
  oldContent?: string
}

interface FileEntry {
  path: string
  ops: FileOp[]
  lastTs: number
}

const ACTION_KEY: Record<FileOp['action'], I18nKey> = {
  view: 'files.opView',
  create: 'files.opCreate',
  edit: 'files.opEdit',
}

/**
 * 文件面板。两区，回答两个不同的问题：
 *
 * - **工作区文件**：沙箱里现在有什么（拉自控制面，可下载）——
 *   Agent 用 bash 产出的文件（PDF、表格）不走 textEditor，只有这里能看到。
 * - **编辑记录**：Agent 动过哪些文件、改成了什么样 —— 数据完全来自事件流里
 *   textEditor 的 detail，刷新页面后从持久化事件重建，不额外查沙箱。
 */
function FilesView({ events, sessionId }: { events: AgentEvent[]; sessionId: string | null }) {
  const { t, locale } = useI18n()
  const [openPath, setOpenPath] = useState<string | null>(null)
  const [wsFiles, setWsFiles] = useState<{ path: string; size: number; mtime: number }[] | null>(null)
  const [wsError, setWsError] = useState(false)

  // 任务落地（statusUpdate 非 running）时刷新一次工作区列表 —— 产出物都是这时候定稿的
  const settled = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]
      if (e.type === 'statusUpdate' && e.agentStatus !== 'running') return e.timestamp
    }
    return 0
  }, [events])

  useEffect(() => {
    if (!sessionId) return
    let dead = false
    setWsError(false)
    fetch(`${SOCKET_URL}/sessions/${sessionId}/files`, { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => !dead && setWsFiles(d.files))
      .catch(() => !dead && setWsError(true))
    return () => {
      dead = true
    }
  }, [sessionId, settled])

  const files = useMemo<FileEntry[]>(() => {
    const byPath = new Map<string, FileEntry>()
    for (const e of events) {
      if (e.type !== 'toolUsed' || !e.detail || !('textEditor' in e.detail)) continue
      const d = e.detail.textEditor
      if (!d.path) continue
      let entry = byPath.get(d.path)
      if (!entry) {
        entry = { path: d.path, ops: [], lastTs: 0 }
        byPath.set(d.path, entry)
      }
      // 同一 actionId 会反复 upsert（start/end 各一条），靠时间去重：
      // 同动作同时间戳只留最后一条
      const dup = entry.ops.find((o) => o.action === d.action && Math.abs(o.ts - e.timestamp) < 50)
      if (dup) {
        dup.status = e.status
        dup.content = d.content ?? dup.content
        dup.oldContent = d.oldContent ?? dup.oldContent
      } else {
        entry.ops.push({
          action: d.action,
          ts: e.timestamp,
          status: e.status,
          content: d.content,
          oldContent: d.oldContent,
        })
      }
      entry.lastTs = Math.max(entry.lastTs, e.timestamp)
    }
    return [...byPath.values()].sort((a, b) => b.lastTs - a.lastTs)
  }, [events])

  return (
    <div className="files-list">
      <div className="files-head dim">{t('files.workspace')}</div>
      {wsError ? (
        <div className="files-hint dim">{t('files.unavailable')}</div>
      ) : !wsFiles?.length ? (
        <div className="files-hint dim">{t('files.empty')}</div>
      ) : (
        wsFiles.map((f) => (
          <a
            key={f.path}
            className="file-row file-link"
            href="#"
            onClick={(ev) => {
              ev.preventDefault()
              if (sessionId) void downloadSessionFile(sessionId, f.path)
            }}
            title={t('files.download')}
          >
            <span className="file-path" title={f.path}>
              {f.path}
            </span>
            <span className="file-time dim">{fmtSize(f.size)}</span>
          </a>
        ))
      )}

      <div className="files-head dim">{t('files.edits')}</div>
      {files.length === 0 ? (
        <div className="files-hint dim">{t('files.noEdits')}</div>
      ) : (
        files.map((f) => {
          const open = openPath === f.path
          const actions = [...new Set(f.ops.map((o) => o.action))]
          return (
            <div className="file-entry" key={f.path}>
              <button className="file-row" onClick={() => setOpenPath(open ? null : f.path)}>
                <span className="file-badges">
                  {actions.map((a) => (
                    <span className={`file-badge ${a}`} key={a}>
                      {t(ACTION_KEY[a])}
                    </span>
                  ))}
                </span>
                <span className="file-path" title={f.path}>
                  {f.path}
                </span>
                <span className="file-time dim">
                  {new Date(f.lastTs).toLocaleTimeString(locale, { hour12: false })}
                </span>
              </button>
              {open && (
                <div className="file-detail">
                  {f.ops.map((op, i) => (
                    <OpView op={op} key={i} />
                  ))}
                </div>
              )}
            </div>
          )
        })
      )}
    </div>
  )
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

function OpView({ op }: { op: FileOp }) {
  const { t, locale } = useI18n()
  const time = new Date(op.ts).toLocaleTimeString(locale, { hour12: false })
  if (op.action === 'edit') {
    return (
      <div className="op">
        <div className="op-head dim">{t('files.opEdit')} · {time}</div>
        {op.oldContent && <pre className="op-old">{op.oldContent}</pre>}
        {op.content && <pre className="op-new">{op.content}</pre>}
      </div>
    )
  }
  return (
    <div className="op">
      <div className="op-head dim">
        {t(ACTION_KEY[op.action])} · {time}
      </div>
      {op.content
        ? <pre className="op-content">{op.content}</pre>
        : op.status === 'running'
          ? <div className="dim op-loading">{t('files.opRunning')}</div>
          : null}
    </div>
  )
}
