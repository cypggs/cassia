'use client'

import { useCallback, useEffect, useState } from 'react'
import type { Socket } from 'socket.io-client'
import type { EventEnvelope } from '@cassia/shared'

/** 钱包快照(get_wallet 的 ack)。null = 积分治理未启用(本地开发) */
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
 * 钱包/充值 —— 商业化可选模块的前端一半(后端在 socket-server/src/commercial/)。
 *
 * 与后端的 Commercial 接口同一个思想:主 hook(useCassia)只组合它,
 * 自己不含任何积分 if。开放模式下 get_wallet 回 null,钱包 UI 整个不出现,
 * 行为与引入商业化之前完全一致。
 *
 * 监听都挂在自己的 socket listener 上(socket.io 支持多 listener),
 * 不挤占主事件管线。
 */
export function useWallet(getSocket: () => Socket | null, connected: boolean) {
  /** null = 未启用积分(开放模式) */
  const [wallet, setWallet] = useState<Wallet | null>(null)
  /** 充值弹框开关 —— 「积分不足」事件会自己把它顶开 */
  const [rechargeOpen, setRechargeOpen] = useState(false)

  useEffect(() => {
    if (!connected) return
    const s = getSocket()
    if (!s) return
    // 积分治理未启用时 ack 是 null —— setWallet(null),UI 不出现
    const fetchWallet = () => s.emit('get_wallet', {}, (w: Wallet | null) => setWallet(w))
    fetchWallet()
    // 重连后余额可能已变(其它端充值/扣费),每次 connect 重拉
    s.on('connect', fetchWallet)
    // 扣费/入账后的余额推送(用户级房间,不属任何会话)
    const onWalletUpdate = ({ balance }: { balance: number }) =>
      setWallet((prev) => (prev ? { ...prev, balance } : prev))
    s.on('wallet_update', onWalletUpdate)
    // 积分被拦:顶开充值弹框(这条 statusUpdate 也照常进事件流,时间线留痕)
    const onEvent = ({ event }: EventEnvelope) => {
      if (event.type === 'statusUpdate' && event.code === 'insufficient_credits') setRechargeOpen(true)
    }
    s.on('event', onEvent)
    return () => {
      s.off('connect', fetchWallet)
      s.off('wallet_update', onWalletUpdate)
      s.off('event', onEvent)
    }
  }, [connected, getSocket])

  /** 开收银台:ack 拿回托管页 URL,新标签打开(不离开工作台) */
  const createCheckout = useCallback(
    (pack: string): Promise<string | null> =>
      new Promise((resolve) => {
        getSocket()?.emit('create_checkout', { pack }, (r: { checkoutUrl: string } | null) => {
          resolve(r?.checkoutUrl ?? null)
        })
      }),
    [getSocket],
  )

  const refreshWallet = useCallback(() => {
    getSocket()?.emit('get_wallet', {}, (w: Wallet | null) => setWallet(w))
  }, [getSocket])

  return { wallet, rechargeOpen, setRechargeOpen, createCheckout, refreshWallet }
}
