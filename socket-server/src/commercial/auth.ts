/**
 * 控制面鉴权（InsForge 内省）。
 *
 * 令牌是 InsForge 签发的用户 accessToken（RS256 JWT）。我们不本地验签 ——
 * 签名公钥在后端手里，而且验签看不出「已注销/已登出」。统一走内省：
 * GET {INSFORGE_URL}/api/auth/sessions/current，带 60s 缓存，
 * 内省失败的代价最多是 60s 的旧会话宽限。
 *
 * 开关语义：没配 INSFORGE_URL 就是开放模式（本地开发、测试脚本），
 * 所有 userId 都是 null，行为与鉴权引入前完全一致。
 */

export const authEnabled = !!process.env.INSFORGE_URL

const INSFORGE_URL = process.env.INSFORGE_URL?.replace(/\/$/, '')

export interface AuthUser {
  /** InsForge 用户 id（uuid） */
  uid: string
  email?: string
  name?: string
  image?: string
}

interface CacheEntry {
  user: AuthUser | null
  expires: number
}

const CACHE_TTL_MS = 60_000
const cache = new Map<string, CacheEntry>()

// 缓存只增不减会漏 —— 令牌有期，顺手清掉过期项
setInterval(() => {
  const now = Date.now()
  for (const [k, v] of cache) if (v.expires <= now) cache.delete(k)
}, CACHE_TTL_MS).unref()

export async function verifyToken(token: string): Promise<AuthUser | null> {
  if (!INSFORGE_URL) return null
  const hit = cache.get(token)
  if (hit && hit.expires > Date.now()) return hit.user

  const user = await introspect(token)
  cache.set(token, { user, expires: Date.now() + CACHE_TTL_MS })
  return user
}

async function introspect(token: string): Promise<AuthUser | null> {
  try {
    const r = await fetch(`${INSFORGE_URL}/api/auth/sessions/current`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    })
    if (!r.ok) return null
    const body = (await r.json()) as {
      user?: {
        id?: string
        email?: string
        profile?: { name?: string; avatar_url?: string } | null
      }
    }
    if (!body.user?.id) return null
    return {
      uid: body.user.id,
      email: body.user.email,
      name: body.user.profile?.name ?? undefined,
      image: body.user.profile?.avatar_url ?? undefined,
    }
  } catch {
    // 后端不可达按「验不过」处理 —— 宁可拒连也不放行
    return null
  }
}

/** 从 HTTP 请求的 Authorization: Bearer 头里取并验令牌 */
export async function verifyRequest(req: {
  headers: { authorization?: string }
}): Promise<AuthUser | null> {
  const m = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)
  return m ? verifyToken(m[1]) : null
}
