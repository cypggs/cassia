'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { io, type Socket } from 'socket.io-client'
import type {
  AgentEvent,
  ChatEvent,
  EventEnvelope,
  JoinSessionAck,
  SessionSummary,
} from '@cassia/shared'
import { SOCKET_URL, getSocketToken, authHeaders } from './commercial/authToken'
import { useI18n } from './i18n'

export { SOCKET_URL }

export type Attachment = NonNullable<ChatEvent['attachments']>[number]

/** 钱包快照（get_wallet 的 ack）。null = 积分治理未启用（本地开发） */
export interface Wallet {
  balance: number
  ledger: {
    id: string
    delta: number
    reason: 'trial' | 'purchase' | 'usage' | 'adjust'
    ref: string | null
    balanceAfter: number
    createdAt: number
  }[]
  packs: { key: string; amount: string; credits: number }[]
  waffo: boolean
}

/**
 * 前端的全部状态都在这里。
 *
 * 事件按 id upsert，不是无脑 push —— assistant 的流式消息和同一次工具调用的
 * 多次进展都复用同一个 id，靠覆盖而不是追加来更新。这样即使事件重复投递
 * 或乱序到达，最终态也是对的。
 *
 * `lastMessageId` 是续传游标：断线重连时报给服务端，只补差集。
 */
export function useCassia() {
  const { t } = useI18n()
  const socketRef = useRef<Socket | null>(null)
  const [connected, setConnected] = useState(false)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [events, setEvents] = useState<AgentEvent[]>([])
  const lastIdRef = useRef<string | undefined>(undefined)
  /** 钱包。null = 未启用积分（开放模式） */
  const [wallet, setWallet] = useState<Wallet | null>(null)
  /** 充值弹框开关 —— 「积分不足」事件会自己把它顶开 */
  const [rechargeOpen, setRechargeOpen] = useState(false)
  /** 会话加载失败计数（join ack null）—— 页面据此弹 toast 提示重试 */
  const [loadError, setLoadError] = useState(0)

  useEffect(() => {
    // 令牌从模块级存放点读（AuthGate 在挂载前已写好；开放模式为 null）
    const token = getSocketToken()
    const s = io(SOCKET_URL, {
      transports: ['websocket'],
      auth: token ? { token } : undefined,
    })
    socketRef.current = s

    s.on('connect', () => {
      setConnected(true)
      s.emit('list_sessions', {}, (list: SessionSummary[]) => setSessions(list))
      // 积分治理未启用时 ack 是 null —— 钱包 UI 整个不出现
      s.emit('get_wallet', {}, (w: Wallet | null) => setWallet(w))
      // 重连：带游标回来，服务端只补差集
      const sid = currentSessionRef.current
      if (sid) {
        s.emit('join_session', { sessionId: sid, lastMessageId: lastIdRef.current },
          (ack: JoinSessionAck | null) => ack && applyEvents(ack.events))
      }
    })
    s.on('disconnect', () => setConnected(false))
    // 令牌过期的唯一表现就是连不上 —— 通知 AuthGate 重取令牌
    s.on('connect_error', (err) => {
      if (err.message === 'unauthorized') window.dispatchEvent(new Event('cassia:unauthorized'))
    })
    s.on('event', ({ sessionId: sid, event }: EventEnvelope) => {
      // 积分被拦：顶开充值弹框（这条 statusUpdate 也照常进事件流，时间线留痕）
      if (event.type === 'statusUpdate' && event.code === 'insufficient_credits') setRechargeOpen(true)
      if (sid !== currentSessionRef.current) return
      applyEvents([event])
    })
    // 扣费/入账后的余额推送（用户级房间，不属任何会话）
    s.on('wallet_update', ({ balance }: { balance: number }) => {
      setWallet((prev) => (prev ? { ...prev, balance } : prev))
    })
    // 会话被删（本端或其它端）：从列表抹掉；正好是当前会话就连视图一起清
    s.on('session_deleted', ({ sessionId: sid }: { sessionId: string }) => {
      setSessions((prev) => prev.filter((x) => x.id !== sid))
      if (currentSessionRef.current === sid) {
        currentSessionRef.current = null
        setSessionId(null)
        setEvents([])
        lastIdRef.current = undefined
      }
    })

    return () => {
      s.close()
      socketRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const currentSessionRef = useRef<string | null>(null)
  useEffect(() => {
    currentSessionRef.current = sessionId
  }, [sessionId])

  const applyEvents = useCallback((incoming: AgentEvent[]) => {
    if (!incoming.length) return
    for (const e of incoming) {
      if (e.noPersistent !== true) lastIdRef.current = e.id
    }
    setEvents((prev) => {
      const byId = new Map(prev.map((e) => [e.id, e] as const))
      for (const e of incoming) byId.set(e.id, e)
      return [...byId.values()].sort((a, b) => a.timestamp - b.timestamp)
    })
    // 会话列表只在标题/状态可能变化时刷新 —— 终端增量每秒好几条，
    // 跟着一起刷会把控制面打满。
    if (incoming.some((e) => e.type === 'statusUpdate' || e.type === 'chat')) {
      socketRef.current?.emit('list_sessions', {}, (list: SessionSummary[]) => setSessions(list))
    }
  }, [])

  const openSession = useCallback((id: string) => {
    const s = socketRef.current
    if (!s) return
    const prev = currentSessionRef.current
    if (prev && prev !== id) s.emit('leave_session', { sessionId: prev })
    setSessionId(id)
    currentSessionRef.current = id
    setEvents([])
    lastIdRef.current = undefined
    s.emit('join_session', { sessionId: id }, (ack: JoinSessionAck | null) => {
      if (ack) applyEvents(ack.events)
      else setLoadError((n) => n + 1)
    })
  }, [applyEvents])

  const newSession = useCallback(() => {
    socketRef.current?.emit('create_session', {}, (s: SessionSummary) => {
      setSessions((prev) => [s, ...prev])
      openSession(s.id)
    })
  }, [openSession])

  const refreshSessions = useCallback(() => {
    socketRef.current?.emit('list_sessions', {}, (list: SessionSummary[]) => setSessions(list))
  }, [])

  const renameSession = useCallback(
    (id: string, title: string) => {
      socketRef.current?.emit('rename_session', { sessionId: id, title }, (ok: boolean) => {
        if (ok) refreshSessions()
      })
    },
    [refreshSessions],
  )

  const togglePin = useCallback(
    (id: string, pinned: boolean) => {
      socketRef.current?.emit('pin_session', { sessionId: id, pinned }, (ok: boolean) => {
        if (ok) refreshSessions()
      })
    },
    [refreshSessions],
  )

  const deleteSession = useCallback((id: string) => {
    // 列表/视图的清理由服务端广播的 session_deleted 统一做（本端异端一致），
    // 这里只兜底刷新一次列表
    socketRef.current?.emit('delete_session', { sessionId: id })
  }, [])

  const send = useCallback((text: string, attachments?: Attachment[]) => {
    const s = socketRef.current
    if (!s || !text.trim()) return
    const sid = currentSessionRef.current
    if (sid) {
      s.emit('send_message', { sessionId: sid, text, attachments })
      return
    }
    // 还没会话：发送即建任务 —— 进来就能打字，不用先点「新任务」
    s.emit('create_session', {}, (sess: SessionSummary) => {
      setSessions((prev) => [sess, ...prev])
      openSession(sess.id)
      s.emit('send_message', { sessionId: sess.id, text, attachments })
    })
  }, [openSession])

  /** 任务跑着的时候插话 */
  const steer = useCallback((text: string, attachments?: Attachment[]) => {
    const sid = currentSessionRef.current
    if (!sid || !text.trim()) return
    socketRef.current?.emit('steer', { sessionId: sid, text, attachments })
  }, [])

  /**
   * 上传附件到当前会话的沙箱（uploads/ 下）。返回的元数据随下一条消息发出，
   * 控制面会在 prompt 里告诉 Agent 文件在哪。
   * 用 XHR 不用 fetch —— fetch 拿不到上传进度。
   */
  const upload = useCallback((file: File, onProgress?: (pct: number) => void): Promise<Attachment> => {
    const sid = currentSessionRef.current
    if (!sid) return Promise.reject(new Error(t('error.noSession')))
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', `${SOCKET_URL}/sessions/${sid}/files?name=${encodeURIComponent(file.name)}`)
      const headers = authHeaders()
      if (headers.Authorization) xhr.setRequestHeader('Authorization', headers.Authorization)
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress?.(Math.round((e.loaded / e.total) * 100))
      }
      xhr.onload = () => {
        try {
          const body = JSON.parse(xhr.responseText || '{}')
          if (xhr.status === 200) resolve(body as Attachment)
          else reject(new Error(body.error ?? `${t('error.uploadFailed')} (${xhr.status})`))
        } catch {
          reject(new Error(`${t('error.uploadFailed')} (${xhr.status})`))
        }
      }
      xhr.onerror = () => reject(new Error(t('error.network')))
      xhr.send(file)
    })
  }, [t])

  const abort = useCallback(() => {
    const sid = currentSessionRef.current
    if (sid) socketRef.current?.emit('abort', { sessionId: sid })
  }, [])

  /** 开收银台：ack 拿回托管页 URL，新标签打开（不离开工作台） */
  const createCheckout = useCallback((pack: string): Promise<string | null> => {
    return new Promise((resolve) => {
      socketRef.current?.emit('create_checkout', { pack }, (r: { checkoutUrl: string } | null) => {
        resolve(r?.checkoutUrl ?? null)
      })
    })
  }, [])

  const refreshWallet = useCallback(() => {
    socketRef.current?.emit('get_wallet', {}, (w: Wallet | null) => setWallet(w))
  }, [])

  const status = derivedStatus(events)

  /** 当前会话累计消耗（积分快照之和）—— 任务行/时间线共用一个数 */
  const sessionCredits = events.reduce(
    (sum, e) => (e.type === 'usageReport' ? sum + (e.credits ?? 0) : sum),
    0,
  )

  return {
    connected, sessions, sessionId, events, status,
    newSession, openSession, send, steer, abort, upload,
    renameSession, togglePin, deleteSession,
    wallet, sessionCredits, createCheckout, refreshWallet,
    rechargeOpen, setRechargeOpen, loadError,
  }
}

function derivedStatus(events: AgentEvent[]): 'running' | 'stopped' | 'failed' {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.type === 'statusUpdate') return e.agentStatus
  }
  return 'stopped'
}
