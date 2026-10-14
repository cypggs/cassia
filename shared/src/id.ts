import { randomBytes } from 'node:crypto'

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

/**
 * 22 位字母数字 ID（`^[A-Za-z0-9]{22}$`）。
 *
 * 长度不是随便选的：事件 ID 要能当游标用，客户端断线重连时带
 * `lastMessageId` 回来，服务端只补差集。22 位 base62 ≈ 131 bit 熵，
 * 足够在不做协调的前提下由任意节点生成而不撞车。
 */
export function nid(size = 22): string {
  const bytes = randomBytes(size)
  let out = ''
  for (let i = 0; i < size; i++) out += ALPHABET[bytes[i] % ALPHABET.length]
  return out
}
