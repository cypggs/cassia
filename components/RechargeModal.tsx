'use client'

import { useState } from 'react'
import type { Wallet } from '@/lib/commercial/useWallet'
import { useI18n } from '@/lib/i18n'

/**
 * 充值弹框：三档积分包卡片 → waffo 托管收银台（新标签打开，不离开工作台）。
 * 支付成功跳回 ?checkout=success，积分经 webhook 入账后由 wallet_update 推到余额上。
 */
export function RechargeModal({
  wallet,
  open,
  onClose,
  createCheckout,
}: {
  wallet: Wallet
  open: boolean
  onClose(): void
  createCheckout(pack: string): Promise<string | null>
}) {
  const { t } = useI18n()
  /** 正在开收银台的档位（防连点） */
  const [opening, setOpening] = useState<string | null>(null)
  /** 开收银台失败的提示（waffo 侧拒单/网络抖动）—— 不能静默没反应 */
  const [failed, setFailed] = useState(false)

  if (!open) return null

  const buy = async (pack: string) => {
    if (opening) return
    setOpening(pack)
    setFailed(false)
    try {
      const url = await createCheckout(pack)
      if (url) {
        window.open(url, '_blank', 'noopener')
        onClose()
      } else {
        setFailed(true)
      }
    } finally {
      setOpening(null)
    }
  }

  // 大额多送：以最小档单价为基准算「多送 %」
  const base = wallet.packs.length ? wallet.packs[0].credits / Number(wallet.packs[0].amount) : 0

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal recharge" role="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>{t('recharge.title')}</h3>
        <p className="dim">{t('recharge.sub')}</p>
        {!wallet.waffo || wallet.packs.length === 0 ? (
          <p className="dim recharge-unavailable">{t('recharge.unavailable')}</p>
        ) : (
          <div className="pack-grid">
            {wallet.packs.map((p, i) => {
              const bonus = Math.round((p.credits / Number(p.amount) / base - 1) * 100)
              const best = i === wallet.packs.length - 1
              return (
                <button
                  key={p.key}
                  className={best ? 'pack-card best' : 'pack-card'}
                  disabled={opening !== null}
                  onClick={() => void buy(p.key)}
                >
                  {best && <span className="pack-badge">{t('recharge.bestValue')}</span>}
                  <span className="pack-credits">
                    {p.credits.toLocaleString()} <small>{t('credits.credits')}</small>
                  </span>
                  <span className="pack-price">${p.amount}</span>
                  {bonus > 0 && <span className="pack-bonus">+{bonus}%</span>}
                  <span className="pack-buy">
                    {opening === p.key ? t('recharge.opening') : t('recharge.buy')}
                  </span>
                </button>
              )
            })}
          </div>
        )}
        {failed && <p className="recharge-failed">{t('recharge.failed')}</p>}
        <div className="modal-actions">
          <button className="modal-cancel" onClick={onClose}>
            {t('recharge.close')}
          </button>
        </div>
      </div>
    </div>
  )
}
