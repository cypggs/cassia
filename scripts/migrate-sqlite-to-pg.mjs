/**
 * 存量数据迁移：SQLite（cassia.db）→ InsForge Postgres。
 *
 * 幂等：主键冲突一律 DO NOTHING，重跑安全。sessions 和 events 全量搬，
 * user_id 原样带过去（InsForge uid 是 UUID，PG 列是 uuid 类型自动收）。
 *
 * 用法：
 *   node scripts/migrate-sqlite-to-pg.mjs [--from <sqlite路径>]
 *   --from 缺省读 DB_PATH 或 .workspace/cassia.db；PG 连接串从 CLI 现取。
 *
 * 生产迁移实况（2026-08-04）：VM 上 scp 下 ~/cassia-data/cassia.db，
 * 本地跑本脚本，3 条会话（含真实用户的「你好」）+ 全部事件入库。
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'

const argi = process.argv.indexOf('--from')
const sqlitePath = argi > 0 ? process.argv[argi + 1] : (process.env.DB_PATH ?? '.workspace/cassia.db')
if (!existsSync(sqlitePath)) {
  console.error(`SQLite 库不存在: ${sqlitePath}`)
  process.exit(1)
}

const databaseUrl = execFileSync('npx', ['@insforge/cli', 'db', 'connection-string'], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
}).trim()
if (!databaseUrl.startsWith('postgres')) {
  console.error('没拿到 PG 连接串（项目已 link？）:', databaseUrl)
  process.exit(1)
}

// node:sqlite 与 pg 都从 socket-server 的依赖里取（根 package.json 没有）
const require = createRequire(new URL('../socket-server/package.json', import.meta.url))
const { DatabaseSync } = await import('node:sqlite')
const pg = require('pg')

const lite = new DatabaseSync(sqlitePath)
const sessions = lite.prepare('SELECT * FROM sessions').all()
const events = lite.prepare('SELECT * FROM events').all()
console.log(`SQLite 读出：${sessions.length} 条会话，${events.length} 条事件`)

const client = new pg.Client({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } })
await client.connect()

let sOk = 0
for (const s of sessions) {
  const r = await client.query(
    `INSERT INTO public.sessions (id, title, created_at, updated_at, agent_status, sandbox_id, user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING`,
    [s.id, s.title, s.created_at, s.updated_at, s.agent_status, s.sandbox_id, s.user_id ?? null],
  )
  sOk += r.rowCount
}
console.log(`sessions：新插入 ${sOk}，跳过（已存在）${sessions.length - sOk}`)

// 批量插 events，一条一条打 round-trip 太慢
let eOk = 0
const BATCH = 200
for (let i = 0; i < events.length; i += BATCH) {
  const batch = events.slice(i, i + BATCH)
  const values = batch.map((_, j) => `($${j * 4 + 1}, $${j * 4 + 2}, $${j * 4 + 3}, $${j * 4 + 4})`).join(', ')
  const params = batch.flatMap((e) => [e.id, e.session_id, e.ts, e.payload])
  const r = await client.query(
    `INSERT INTO public.events (id, session_id, ts, payload) VALUES ${values} ON CONFLICT (id) DO NOTHING`,
    params,
  )
  eOk += r.rowCount
}
console.log(`events：新插入 ${eOk}，跳过（已存在）${events.length - eOk}`)

await client.end()
console.log('迁移完成')
