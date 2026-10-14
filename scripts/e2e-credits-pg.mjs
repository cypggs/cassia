/**
 * test:credits 的 PostgreSQL 变体：同一套积分断言，但控制面直连
 * InsForge Postgres（生产同款存储路径），跑完清掉测试用户的账务数据。
 *
 *   pnpm test:credits:pg
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
await import('./e2e-credits.mjs')
