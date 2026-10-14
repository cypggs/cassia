#!/usr/bin/env node
/**
 * 沙箱「存储账单」对账。
 *
 * paused 沙箱的快照会一直占 E2B 存储配额直到被清（getMetrics 只覆盖
 * 运行中的沙箱，paused 拿不到精确存储量 —— 所以这份报告以数量×状态×
 * 年龄为准，不猜字节数）。两类该清的对象：
 *
 *   1. 孤儿沙箱：DB 里没有任何会话指向它（删会话时 kill 失败的漏网，
 *      或服务重启与 E2B 侧状态错位）。没人会再接回它 —— 直接 kill。
 *   2. 超龄休眠：paused 超过 SANDBOX_MAX_AGE_DAYS（默认 30 天）。
 *      用户大概率不回来了，快照不能无限期帮它占位。
 *
 * 默认只报告；加 --kill 才真删。VM 上 cron 每日跑（带 --kill），
 * 输出进 journal 可追溯。
 *
 * 用法：
 *   set -a && source .env && set +a
 *   node scripts/sandbox-storage-report.mjs [--kill]
 *
 * 需要：E2B_API_KEY；DATABASE_URL（PG）或 DB_PATH（SQLite 本地库）。
 */
import { createRequire } from 'node:module'

const require = createRequire(new URL('../socket-server/package.json', import.meta.url))
const { Sandbox } = await import(require.resolve('e2b'))

const KILL = process.argv.includes('--kill')
const MAX_AGE_DAYS = Number(process.env.SANDBOX_MAX_AGE_DAYS ?? 30)
const MAX_AGE_MS = MAX_AGE_DAYS * 86_400_000

/** DB 里所有会话 id 和它们记住的 sandboxId */
async function loadDbSessions() {
  if (process.env.DATABASE_URL) {
    const pg = require('pg')
    const pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    })
    try {
      const { rows } = await pool.query('SELECT id, sandbox_id FROM sessions')
      return rows.map((r) => ({ id: r.id, sandboxId: r.sandbox_id }))
    } finally {
      await pool.end()
    }
  }
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(process.env.DB_PATH ?? '.workspace/cassia.db')
  try {
    return db
      .prepare('SELECT id, sandbox_id AS sandboxId FROM sessions')
      .all()
      .map((r) => ({ id: r.id, sandboxId: r.sandboxId }))
  } finally {
    db.close()
  }
}

const sessions = await loadDbSessions()
const sessionIds = new Set(sessions.map((s) => s.id))
const knownSandboxIds = new Set(sessions.map((s) => s.sandboxId).filter(Boolean))

// 全量分页（running + paused 都要 —— paused 才是存储账单的被告）
const paginator = Sandbox.list()
const sandboxes = []
while (paginator.hasNext) {
  sandboxes.push(...(await paginator.nextItems()))
}

const now = Date.now()
const orphans = []
const aged = []
const healthy = []

for (const sb of sandboxes) {
  const metaSession = sb.metadata?.sessionId
  // 归属判定：metadata 指着的会话还在，或 DB 有会话记得这个 sandboxId
  const claimed = (metaSession && sessionIds.has(metaSession)) || knownSandboxIds.has(sb.sandboxId)
  const ageDays = (now - new Date(sb.startedAt).getTime()) / 86_400_000
  if (!claimed) orphans.push({ sb, ageDays })
  else if (sb.state === 'paused' && ageDays > MAX_AGE_DAYS) aged.push({ sb, ageDays })
  else healthy.push({ sb, ageDays })
}

const byState = (list) =>
  list.reduce((m, { sb }) => ((m[sb.state] = (m[sb.state] ?? 0) + 1), m), {})

console.log(`[sandbox-storage] 共 ${sandboxes.length} 台：健康 ${healthy.length}（${JSON.stringify(byState(healthy))}）` +
  ` / 孤儿 ${orphans.length} / paused 超龄（>${MAX_AGE_DAYS}d）${aged.length}`)

for (const { sb, ageDays, why } of [
  ...orphans.map((o) => ({ sb: o.sb, ageDays: o.ageDays, why: 'orphan' })),
  ...aged.map((a) => ({ sb: a.sb, ageDays: a.ageDays, why: 'aged' })),
]) {
  const line = `  ${why}  ${sb.sandboxId}  state=${sb.state}  age=${ageDays.toFixed(1)}d  session=${sb.metadata?.sessionId ?? '?'}`
  if (!KILL) {
    console.log(`${line}  （--kill 才会删）`)
    continue
  }
  try {
    await Sandbox.kill(sb.sandboxId)
    console.log(`${line}  ✂ killed`)
  } catch (e) {
    console.warn(`${line}  ⚠ kill 失败: ${e instanceof Error ? e.message : e}`)
  }
}

if (!KILL && (orphans.length || aged.length)) {
  console.log('[sandbox-storage]  dry-run 完毕，加 --kill 执行清理')
}
