'use client'

/**
 * 控制面令牌的前端存放点。
 *
 * 开放模式（未启用 InsForge 登录）下永远是 null，所有请求不带
 * Authorization，控制面也放行 —— 行为与鉴权引入前一致。
 * 启用登录后由 AuthGate 从 InsForge SDK 取出 accessToken 写入。
 */

export const SOCKET_URL = process.env.NEXT_PUBLIC_SOCKET_URL ?? 'http://localhost:4000'

let token: string | null = null

export function setSocketToken(t: string | null): void {
  token = t
}

export function getSocketToken(): string | null {
  return token
}

export function authHeaders(): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {}
}

/**
 * 下载会话文件。裸 <a href> 带不了 Authorization 头，鉴权模式会 401，
 * 所以统一走 fetch + blob（开放模式下也不带任何多余的东西）。
 */
export async function downloadSessionFile(sessionId: string, path: string): Promise<void> {
  const r = await fetch(
    `${SOCKET_URL}/sessions/${sessionId}/file?path=${encodeURIComponent(path)}`,
    { headers: authHeaders() },
  )
  if (!r.ok) throw new Error(`下载失败（${r.status}）`)
  const blob = await r.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = path.split('/').pop() ?? 'download'
  a.click()
  URL.revokeObjectURL(url)
}
