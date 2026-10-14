# 可选：用 InsForge 接入登录与多用户

Cassia 默认是**开放模式**：不配任何 InsForge 变量就没有登录门，
所有人直连即用，积分治理静默关闭 —— 本地开发和自用部署开箱即用。

当你需要多用户 + 登录 + 按用户隔离会话 + 积分扣费时，
把认证/用户库外包给 [InsForge](https://insforge.dev)
（开源 BaaS：Postgres + Auth + Storage，一条 docker-compose 可自托管）。
**开关由环境变量驱动**，两侧独立：

```bash
# 前端：两个都配了才出现登录门
NEXT_PUBLIC_INSFORGE_URL=https://<appkey>.<region>.insforge.app
NEXT_PUBLIC_INSFORGE_ANON_KEY=anon_...   # npx @insforge/cli secrets get ANON_KEY

# socket-server：配了才强制鉴权 + 按用户隔离
INSFORGE_URL=https://<appkey>.<region>.insforge.app   # 同上，不带 NEXT_PUBLIC_
```

## 行为

- 未登录连不上 socket（`unauthorized`）；文件端点无令牌 401。
- 会话按 InsForge 用户 id 隔离；别人的会话一律 404（不暴露是否存在）。
- 鉴权引入前的存量会话（无属主）封存不可见。
- 令牌校验走内省（`GET /api/auth/sessions/current`，60s 缓存），不本地验签。
- 令牌过期自愈：控制面拒连 → 前端重取 accessToken → 重挂载 Workspace。
- 模型 key 仍是平台级共享（沙箱里 pi 用部署方统一配的 key），
  按用户配额 / 自带 key 留作后续。

OAuth 应用在 InsForge dashboard 配置；前端回调地址加进
`insforge.toml` 的 `auth.allowed_redirect_urls` 后
`npx @insforge/cli config apply`。

## 存储

配了 `DATABASE_URL` 就用 `PgStore`（生产，InsForge Postgres），
否则 `SqliteStore`（零外部服务）。表结构在 `migrations/`，
用 `npx @insforge/cli db migrations up --all` 应用。

## 积分与支付（waffo）

`creditsEnabled = INSFORGE_URL 已配`。支付走 waffo 托管收银台，
凭证全在 server-only 环境变量（见 `.env.example`），
`scripts/waffo-setup.mjs` 一次性建好产品。未配置时充值弹框显示
「支付通道尚未配置」—— 开源默认即 mock 状态。

## 验证

```bash
pnpm test:auth     # 9 项断言：拒连 / 隔离 / 404 / 登录态全链路（SQLite）
pnpm test:auth:pg  # 同 9 项，直连 InsForge Postgres
pnpm test:credits  # 试用发放 / 耗尽拦截 / 扣费一致性（SQLite）
```
