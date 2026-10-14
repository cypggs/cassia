# Cassia

开源的通用智能体平台 —— 给 Agent 一台真实的电脑，并把整个过程实时呈现出来。

定位是**连接器**，不是重新发明轮子：沙箱用 E2B，Agent 循环用 pi，
画面串流用 noVNC，事件模型是自己定义的一套（见 `shared/src/events.ts`）。

```
┌──────────┬─────────────────────────┬──────────────────────┐
│ 任务列表  │      执行过程            │      计算环境         │
│          │                         │  终端 / 浏览器        │
│ 历史会话  │  对话 · 工具 · 计划      │  文件 / 代码运行      │
└──────────┴─────────────────────────┴──────────────────────┘
```

## 开箱即用：登录与支付默认是 mock 的

- **登录**：不配 InsForge 环境变量就是开放模式 —— 没有登录门，
  打开即用。需要多用户 + OAuth 时再按 `docs/04-insforge-backend.md` 接入。
- **支付/积分**：不配 waffo 凭证时充值弹框显示「支付通道尚未配置」，
  积分治理静默关闭，所有功能照常可用。

## 本地跑起来

```bash
pnpm install
cp .env.example .env

# socket-server 需要 .env 进进程环境（provider key 随 attach 下发进沙箱，
# 漏了的话沙箱里的 pi 会在第一次 LLM 调用时无声死掉）。pnpm 不会自动加载：
set -a && source .env && set +a

# 三个进程，三个终端（dev:socket 要在 source 过 .env 的终端里起）
pnpm dev:runtime   # agent-runtime :8330  ← 驱动 pi
pnpm dev:socket    # socket-server :4000  ← 事件流 + 沙箱生命周期
pnpm dev:web       # Next.js       :3000
```

打开 http://localhost:3000 → 新任务 → 给它一个目标。

本机模式下 pi 直接读 `~/.pi/agent/auth.json`，不用另配 key。

不开浏览器验证整条链路：

```bash
node scripts/e2e.mjs             # 流式：终端输出必须分多次增量到达
node scripts/e2e-isolation.mjs   # 隔离：两个会话并发跑，互不串台
node scripts/e2e-persistence.mjs # 持久化：控制面重启不丢历史（自持，自己起停）
node scripts/e2e-dormancy.mjs    # 休眠：沙箱空闲被暂停而非销毁，唤醒后状态全保留
```

## 部署到云上（一台服务器 all-in-one）

整套服务可以跑在一台 2vCPU/2GB 的云服务器上：

| 组件 | 跑在哪 | 说明 |
|---|---|---|
| Next.js 前端 | 本机 :3000 | `next start`，systemd 托管 |
| socket-server | 本机 :4000 | 事件流 + E2B 沙箱生命周期，systemd 托管 |
| agent-runtime | E2B 沙箱内 :8330 | 随任务按需起，不占服务器资源 |
| Caddy | :80/:443 | 单域名反代 + 自动签证书（`deploy/Caddyfile`） |
| 存储 | SQLite 单文件 | 零外部服务；要 Postgres 再配 `DATABASE_URL` |

**你需要准备的资源**（按 `.env.example` 逐项填进服务器的 `.env.production`）：

1. **E2B API key**（必需）—— 沙箱算力：https://e2b.dev
2. **模型 key**（必需）—— `DEEPSEEK_API_KEY` 或 `ANTHROPIC_API_KEY`，
   随 WebSocket attach 下发进沙箱，不烤进镜像、不进 E2B 环境变量
3. **域名**（推荐）—— Caddy 自动签 Let's Encrypt；纯 IP 也能跑（http）
4. 可选：InsForge（登录/多用户）、waffo（支付）。不配就是 mock 状态。

**部署步骤**：

```bash
# 0. 先构建 E2B 沙箱模板（见下节「构建沙箱模板」），拿到模板名

# 1. 服务器一次性准备：Node 22 + pnpm + Caddy；
#    deploy/cassia-socket.service + deploy/cassia-web.service → /etc/systemd/system/
#    deploy/Caddyfile 改好域名 → /etc/caddy/Caddyfile
#    写好 ~/cassia/.env.production（密钥只在这里，不进 git）

# 2. 本机一键发布（本机预构建，服务器只跑不编）
VM_HOST=1.2.3.4 ./scripts/deploy.sh
```

`.env.production` 最小集合：

```bash
E2B_API_KEY=e2b_...
DEEPSEEK_API_KEY=sk-...
PI_MODEL=deepseek/deepseek-chat
E2B_TEMPLATE=cassia-lite        # 你构建的模板名
NEXT_PUBLIC_SOCKET_URL=https://your-domain.com
NEXT_PUBLIC_SUPPORT_EMAIL=you@example.com
CORS_ORIGIN=https://your-domain.com
```

注意：`NEXT_PUBLIC_*` 在构建时 baked 进前端，改了要重跑 `deploy.sh`。

### 构建沙箱模板

E2B 的 `base` 模板**不能用** —— node 20.9 低于 pi 要求的 22.19。
所以要自己构建，二选一（都在仓库根目录跑，需要 `E2B_API_KEY`）：

```bash
./sandbox-lite/build.sh      # 只有终端。冷启动 ~3s。日常够用。
./sandbox-desktop/build.sh  # 终端 + 浏览器画面。冷启动 ~15s。
```

构建出的模板名填进 `E2B_TEMPLATE`。跑 E2B 模式还要去掉 `AGENT_RUNTIME_URL`。

## 架构

```
浏览器
 │
 ├─ Socket.IO ──► socket-server :4000 ──► E2B API ──► 沙箱生命周期
 │                      │
 │                      └─ WebSocket ──► agent-runtime :8330
 │                                            └─ pi --mode rpc
 │
 └─ wss 直连 ───────────────────────────────► <port>-<sandboxId>.e2b.app
                                                ├─ 5901 websockify → VNC 画面
                                                └─ 8333 neko       → WebRTC 画面
```

**画面永远直连沙箱**，控制面只搬事件（KB 级）不搬画面（MB/s 级）。

agent-runtime 对「自己在哪」无感知 —— 本机跑和沙箱里跑是同一份代码，
差别只在 socket-server 用什么地址拨过来。设了 `AGENT_RUNTIME_URL` 走本机，
不设就起 E2B 沙箱。

**一个会话 = 一个 pi 进程 = 一个工作目录。** 控制面拨过去的第一件事是
`{type:'attach', sessionId}` 认领会话。

## 三个关键设计

**画面直连沙箱。** `wss://<port>-<sandboxId>.<region>/vnc` ——
浏览器直接连沙箱的 websockify，控制面不中转视频流。

**一个事件两种表示。** `toolUsed` 同时带 `message`（给对话气泡）和
`detail`（给右侧面板的原始数据）。中间栏不需要知道终端输出长什么样。

**显示与持久化正交。** `noRender` 和 `noPersistent` 是两个独立布尔量，
不是一个枚举。`liveStatus`（"思考中"）要渲染但不存盘，某些内部状态要存但不渲染 ——
合成一个枚举就会在某个组合上卡住。

## 已知限制

**画面走 VNC 不走 neko。** neko（WebRTC）延迟更低，但它要自定义
X 输入驱动 + GStreamer + Pulse 一整套。VNC 能力上够（画面、输入都有），
换来的是构建从二十几分钟降到几分钟。neko 是延迟优化，已搁置。

**shell 不持久。** pi 的 bash 每次都是全新 shell，`cd` 和 `export` 不跨调用存活。
当前只开一个终端 tab。补齐方案见 `docs/03-pi-rpc.md` §4。

**Next 锁在 15.x。** 16.2.12 + Turbopack 在本机出现间歇 500
（RSC client manifest 错误 + dev 热重载的 `Map maximum size exceeded`），
与本项目代码无关，但会让开发不可用。

**快照有保留期。** 休眠的沙箱不是永久保存的 —— E2B 会清掉睡太久的快照
（具体时长取决于账号等级）。唤醒时发现快照没了，控制面会自动退回到
「起一台新沙箱」，任务历史不丢，但工作目录和进程状态从零开始。

**单实例。** socket-server 是单进程内存态（活会话的 bridge / 休眠计时器都在内存里），
事件虽然落了 SQLite，但横向扩容到多实例前，活会话的归属得先解决。
现在是一个控制面对任意多个沙箱 —— 对个人/小团队部署是对的形状。

## 文档

- **[docs/02-architecture.md](docs/02-architecture.md)** —
  组件选型、pi 事件映射、三栏 UI 与事件的对应、控制面韧性（四次线上事故换来的设计）。
- **[docs/03-pi-rpc.md](docs/03-pi-rpc.md)** —
  pi RPC 协议实测。两处反直觉的地方直接决定了 `translate.ts` 的写法。
- **[docs/04-insforge-backend.md](docs/04-insforge-backend.md)** —
  可选：用 InsForge 接入登录、多用户、积分与支付。

## License

MIT — 见 [LICENSE](LICENSE)。
