/**
 * test:auth 的 PostgreSQL 变体：同一套 9 项断言，但控制面直连
 * InsForge Postgres（生产同款存储路径），跑完清掉测试数据。
 * 连接串从 InsForge CLI 现取（要已 link 项目），不经手 .env。
 *
 *   pnpm test:auth:pg
 */
import { execFileSync } from 'node:child_process'

const url = execFileSync('npx', ['@insforge/cli', 'db', 'connection-string'], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
}).trim()
if (!url.startsWith('postgres')) {
  console.error('没拿到连接串（项目已 link？）:', url)
  process.exit(1)
}

process.env.E2E_DATABASE_URL = url
await import('./e2e-auth.mjs')
