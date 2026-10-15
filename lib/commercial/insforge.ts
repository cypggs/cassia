'use client'

import { createClient } from '@insforge/sdk'

/**
 * InsForge 前端客户端（单例）。
 *
 * 两个 env 都在才算启用登录：缺任何一个都是开放模式，
 * AuthGate 不渲染，行为与引入登录前完全一致。
 *
 * anonKey 是前端安全密钥（后端的 RLS 才是数据边界），可以进
 * NEXT_PUBLIC；service/api key 永远不进这里。
 */

export const INSFORGE_URL = process.env.NEXT_PUBLIC_INSFORGE_URL ?? ''
export const AUTH_ENABLED =
  !!process.env.NEXT_PUBLIC_INSFORGE_URL && !!process.env.NEXT_PUBLIC_INSFORGE_ANON_KEY

export const insforge = AUTH_ENABLED
  ? createClient({
      baseUrl: INSFORGE_URL,
      anonKey: process.env.NEXT_PUBLIC_INSFORGE_ANON_KEY,
    })
  : null
