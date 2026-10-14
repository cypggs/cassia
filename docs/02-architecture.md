# Cassia 架构设计

目标：把成熟的开源组件接成一台「Agent 的电脑」——
不自研 Agent 循环、不自研沙箱、不自研串流，只做**连接器**和**事件模型**。

---

## 1. 组件选型

| 层 | 选型 | 理由 |
|---|---|---|
| 沙箱 | **E2B**（Firecracker microVM） | 快照/恢复、端口转发、SDK 都现成 |
| 沙箱镜像 | `sandbox-lite/` / `sandbox-desktop/`（本仓库） | 自控镜像内容，构建期断言兜底 |
| Agent 循环 | **pi**（`pi --mode rpc`） | 有 session / steering / fork / compaction，且事件流结构化 |
| 画面串流 | **x11vnc/websockify**（VNC） | 构建快、依赖面小；neko（WebRTC）延迟更低但已搁置 |
| 终端渲染 | **xterm.js** | 事件里 ANSI 是保留的，直接喂 |
| 事件传输 | **Socket.IO** | 重连/游标语义现成 |
| 状态 API | **Connect RPC**（`@connectrpc`） | 类型安全；也可先用普通 REST |

---

## 2. 进程拓扑

```
浏览器
 │
 ├─ Connect RPC / REST ──────► control-plane   ── E2B API ──► 沙箱生命周期
 │                                  │
 ├─ Socket.IO（事件流）─────────────┘
 │
 └─ wss 直连 ──────────────────────────────────► <port>-<sandboxId>.e2b.app
                                                   ├─ 5901  websockify → VNC 画面
                                                   ├─ 8333  neko       → WebRTC 画面
                                                   └─ 8330  agent-runtime
                                                              └─ pi --mode rpc
```

**画面永远直连沙箱**，控制面不中转视频 —— 成本和延迟都省。

---

## 3. agent-runtime：沙箱内的那一层

跑在沙箱里、监听 `:8330`，职责只有三件：

1. 用 `pi --mode rpc` 起一个子进程，喂 prompt、收事件
2. 把 pi 的事件**翻译**成本平台的事件模型（下一节），推给控制面
3. 管理具名持久 PTY（`shellId`），把 PTY 字节流也变成事件

它在镜像构建时编译进 `/opt/cassia/runtime/`，由 `start.sh` 拉起。

### 为什么是 pi 而不是自己写循环

`pi --mode rpc` 是 stdin/stdout 的 JSON 行协议，命令集：

```
prompt  steer  follow_up  abort  abort_bash  bash
new_session  switch_session  fork  clone  compact
set_model  cycle_model  set_thinking_level  set_steering_mode
get_state  get_messages  get_entries  get_tree  get_session_stats
export_html  set_session_name  set_auto_compaction  set_auto_retry
```

`steer` 是关键 —— 任务执行中途插话干预，自己写循环要重新踩一遍。
`fork` / `clone` 给「从某一步分支重试」提供了基础。
`compact` + `set_auto_compaction` 解决长任务上下文溢出。

### pi 事件 → 平台事件 映射

完整的 pi 协议实测记录见 **[03-pi-rpc.md](03-pi-rpc.md)**。映射实现在
`agent-runtime/src/translate.ts`：

| pi 事件 | 平台事件 | 备注 |
|---|---|---|
| `agent_start` | `statusUpdate{agentStatus:"running"}` | |
| `agent_settled` | `statusUpdate{agentStatus:"stopped"}` | `agent_end` 早于它，不能用来判完成 |
| `message_update` / `message_end` | `chat{sender:"assistant"}` | 读累积值，按 id upsert |
| `tool_execution_start` | `toolUsed{status:"running"}` | `actionId = toolCallId` |
| `tool_execution_update` | `toolUsed.detail.*{outputType:"append"}` | **需前缀 diff**，见下 |
| `tool_execution_end` | `toolUsed{status:"success"\|"error"}` | |
| `bash_execution_update` | `toolUsed.detail.terminal{outputType:"append"}` | 仅宿主直接调 bash 时 |
| plan 工具（自定义扩展） | `planUpdate` + `newPlanStep` | pi 没有内置 todo 工具（翻遍 0.83.0 dist 确认），由 `pi-extension/plan.ts` 用 `registerTool` 补上。args 即全量快照；doing 步骤迁移时发 newPlanStep 并把后续事件的 `planStepId` 指过去。plan 不产生 `toolUsed` —— 它是计划不是动作 |
**两个实测结论修正了先前的推断：**

1. `tool_execution_update.partialResult` 是**累积快照**（长度单调增长），不是增量。
   推送本身是实时的（每秒一次，与命令输出同步），但要还原成 append 流
   得自己按 `sentLen` 做前缀 diff。
2. `bash_execution_update.delta` 才是真增量，**但只在宿主直接调 `{type:'bash'}` 时触发**，
   模型自己调 bash 工具不走这条。两条路径要分别实现。

**pi 的 bash 原生不是持久 shell**，已由 `agent-runtime/pi-extension/persistent-shell.ts`
补齐：扩展复用 `createBashTool` 只替换 exec 后端，命令落在 node-pty 常驻 bash 上，
cwd / 环境变量跨调用存活（`shellId` 仍恒为 `'main'`，具名多 shell 留作后续）。
细节与输出卫生对策见 `03-pi-rpc.md` §4.1。

**`brief` / `description` 当前是规则生成**（`translate.ts:briefOf`），
比 LLM 摘要信息量低：这里是「执行命令: ls -l /tmp/frp.tar.gz」，
LLM 摘要能写成「检查 /tmp 目录下的文件以确认下载是否成功」。
升级路径是在系统提示里要求主模型每次调工具前先说一句意图 ——
已经写进 `agent-runtime/src/index.ts` 的 `SYSTEM_APPEND`，但还没把那句话
关联到具体的 toolUsed 事件上。

---

## 4. 事件模型

核心不变量：

- 每个事件有 22 位 nanoid，全局单调
- `noRender` / `noPersistent` 两个正交布尔量
- 过程事件带 `planStepId` 回指，中间栏天然分组
- `toolUsed` 双表示：`message` 给对话流，`detail` 给右侧面板
- `planUpdate` 是全量快照而非增量

### 客户端

IndexedDB 存事件日志（`cacheKey = "<sessionId>:<eventId>"`，`by-session` 索引），
重连时带 `lastMessageId` 游标，服务端只补差集。

---

## 5. 三栏 UI 与事件的对应

```
┌──────────┬─────────────────────────┬──────────────────────┐
│ 左：任务  │ 中：执行过程             │ 右：计算环境          │
├──────────┼─────────────────────────┼──────────────────────┤
│ ListSess-│ chat                    │ toolUsed.detail      │
│ ions RPC │ toolUsed.message        │  ├ terminal → xterm  │
│          │ explanation             │  ├ textEditor → diff │
│ 图标+主题 │ planUpdate / newPlanStep│  └ browser  → 画面    │
│ 色/未读数 │ statusUpdate/liveStatus │ sandboxUpdate        │
│ 都在 RPC │                         │  └ vncUrl/webRTCUrl  │
│ 响应里   │                         │    → 直连沙箱         │
└──────────┴─────────────────────────┴──────────────────────┘
```

右侧面板的 tab 由 `toolUsed.tool` 决定；`shellId` 决定终端开第几个 tab。

### 画面的两档精度

neko 除了 WebRTC 还有 `--capture.screencast.*`（JPEG，10fps，quality 60），
开销低一个量级。左侧列表的实时缩略图走 screencast，右侧详情才升到 WebRTC ——
一个沙箱同时供两种精度时省很多。

---

## 6. 附件通道（上传/下载）

不走 socket.io 事件流（KB 级消息的通道），走 socket-server 上的三条 HTTP 端点：

- `POST /sessions/:sid/files?name=` — octet-stream 原始体上传，边收边数边转给
  沙箱（`MAX_UPLOAD_MB`，默认 100MB 超限即断），落点是会话工作目录的 `uploads/`。
- `GET /sessions/:sid/files` — 工作区文件列表（产出物发现：bash 生成的文件
  不走 textEditor 事件，只有文件系统列表能覆盖）。
- `GET /sessions/:sid/file?path=` — 流式下载，`Content-Disposition: attachment`。

读写都经 `RuntimeHandle.writeFile/readFile/listFiles`：e2b 模式调 SDK 的
`sbx.files.*`（二进制流式，不过 ws/base64），本机模式直接读写 `WORKSPACE` 目录，
调用方不分模式。路径全部限定在会话目录内（任何 `.`/`..` 段拒绝）。

两个有意的语义决策：

1. **上传即唤醒**。没沙箱 provision、休眠 resume —— 传文件就是要干活的明确信号；
   反过来，从没开过沙箱的会话调列表/下载**不**为它 provision（返回空/404）。
2. **附件指引只进 prompt 不进气泡**。chat 事件带 `attachments` 元数据（气泡渲染
   下载 chips），发给 pi 的文本追加「文件在当前目录 uploads/ 下，用工具直接读」——
   Agent 需要路径，用户不需要再看一遍自己传的东西。

---

## 7. 分期

**P0 — 打通一条竖线**
E2B 起沙箱 → agent-runtime 驱动 pi → 事件推到前端 → 中间栏出现 `toolUsed`，
右侧 xterm 出现真实终端输出。左侧先写死一个会话。

**P1 — 三栏成形**
会话 CRUD、事件持久化 + 游标续传、右侧 VNC 画面、文件树。

**P2 — 联动能力**
用户接管浏览器（neko `implicit_hosting`）、`steer` 中途干预、
`fork` 从某步分支、附件上传下载。

**P3 — 平台化**
多租户、沙箱池与预热、pause/resume、成本计量。

---

## 8. 待定

- **pause/resume**：P3 之前需要实测 E2B 的 `Sandbox.pause()` / `resume()` 在
  「Chromium + Xorg + supervisord 全开」的情况下能否干净恢复。
- **`brief` 生成策略**：旁路小模型 vs 主模型自述（见 §3）。
- **状态 API 用 Connect RPC 还是先上 REST**：Connect 类型安全，
  但要引 protobuf 工具链；P0 阶段 REST 更快。

---

## 9. 控制面韧性（线上事故换来的，全部锁进混沌测试）

**事故一：任务中途沙箱被 E2B 暂停。** 一条长时间无输出的命令（等网络的 publish）
整场没有一个事件，touch 续期不发生，E2B 到点暂停沙箱 —— 控制面还以为它在跑，
agent 假死、消息进黑洞、停止无效。对策：**agentRunning 期间每分钟心跳续期**
（`socket-server/src/index.ts` 的 heartbeat interval），别让 E2B 在任务中途收走机器。

**事故二：bridge 连进半开僵尸连接。** 沙箱 pause/resume 后，旧的 TCP 连接变成
半开状态：write 成功但字节进黑洞，永远没有 close 事件，重连逻辑永远不触发。
对策：**ws ping/pong 心跳**（`bridge.ts`），两个周期（30s）没 pong 就
`terminate()` 强制走进重连。连续重连失败 6 次（~25s，沙箱被外部
回收的 502 循环）上报 `unreachable`，控制面诚实标记休眠，下条消息走 resume
原地唤醒 —— 不空转假活。另外 **prompt 送达闸**：`prompt()` 返回 true 只证明
写进了 socket，不证明送达（僵尸连接照单全收）—— `deliverMessage` 发出后等
`agent_start`（唯一送达证据）或 `dormant`（沙箱死了的确证）75s，
死窗消息自动补投一次。

**事故三：控制面重启丢沙箱。** live 表是内存的，重启后所有会话重新 provision，
用户正在用的沙箱（和里面的文件、pi 上下文）全丢。对策有三层：

1. **sessions 表持久化 sandbox_id**（sandboxUpdate 落库时写入），
   `ensureRuntime` 发现 live 没有记录时先 `reconnect()` 接回原沙箱
   （connect 自动唤醒 paused；404 重试 4 次，吃掉 E2B 控制面的传播 lag），
   接不上才新建。
2. **关机不杀沙箱。** SIGTERM 只断 bridge —— 重启/部署不该毁掉用户的电脑；
   闲置费用由 E2B lifecycle 兜底（timeout 到点自动 pause，暂停不计费）。
   曾经关机时 kill 全部沙箱，于是「重启后接回」永远是 404，还伪装成
   「沙箱神秘消失」查了很久。
3. `sandboxUpdate` 事件**持久化**（曾经 noPersistent），否则刷新页面后
   画面面板拿不到 vncUrl，误显示「没有图形环境」；前端 `lastSandboxUpdate`
   取「最后一条带地址的」URL + 最新状态。

**事故四：pi 卡死/崩溃，runtime 无感。** 沙箱跨暂停恢复后 pi 可能卡死（挂起的
HTTPS 请求或丢失的 shell 完成标记），崩溃则直接丢对话。对策（agent-runtime）：

- **看门狗**：每 60s 对每个会话的 pi 发 `get_state` 探活，15s 不答判定卡死。
- **自愈**：杀旧进程 → 重起 → `switch_session` 接回落盘上下文（pi 把会话写在
  `~/.pi/agent/sessions/<编码cwd>/`，实测接回后上下文完整；注意编码用的是
  realpath，macOS 的 `/tmp` → `/private/tmp`）→ 广播诚实事件（接回/未接回都
  明说）。限频 10 分钟 3 次，防死亡循环烧 provider 配额。自愈窗口里收到的
  消息进 pendingMsgs 队列，恢复后补发。
- **shell 兜底超时**：pi 的 bash 工具 `timeout` 缺省是**永不超时**，一条
  不退出的命令能把会话挂到天荒地老。persistent-shell 扩展加了兜底
  （`PI_SHELL_BACKSTOP_S`，默认 1800s）。
- **成本安全带**：`agentRunning` 但零事件超过 `STUCK_RUN_MS`（默认 3h）——
  settled 事件丢了或 pi 僵死，「运行中」就是谎话，心跳续期会沿着谎话一直
  烧钱。强制 abort + 诚实 failed 事件 + 判休眠。

**混沌测试**（`scripts/e2e-chaos.mjs`，`npm run test:chaos`）把上述全部锁死：
A 任务中途杀沙箱 → 恢复且诚实；B 杀 pi → 看门狗自愈、上下文接回；
C 重启控制面 → 透明接回原沙箱；D 僵死运行 → 安全带强制收尾。
四场景全绿才算完。

---

## 10. 依赖保鲜：pi 版本策略

pi 大约每周一版。镜像里的 pi **钉死版本、自动化 bump、门禁不过不升** ——
绝不 `pi@latest` 盲升，因为本平台有三处耦合 pi 内部的代码：

- `pi-extension/persistent-shell.ts` — import pi 包的 `createBashTool` / `BashOperations`
- `pi-extension/plan.ts` — `ExtensionAPI` / `registerTool` / TypeBox schema
- `pi-client.ts` — RPC 语义（`get_state` 探活、`switch_session(sessionPath)` 接回上下文）

钉版点三处，必须永远一致：`sandbox-lite/e2b.Dockerfile`、
`sandbox-desktop/e2b.Dockerfile`、`agent-runtime/package.json`（devDep，供类型）。

**`scripts/bump-pi.mjs`（`pnpm bump-pi`）是唯一的升级入口**，流程即门禁：

1. **发现** — `npm view` latest 对比钉版；`--check` 只报告不改动（适合挂周检）。
2. **变更日志** — 拉 GitHub releases 区间说明，含 Breaking Changes 则高亮并要求确认。
3. **本机门禁** — 本机 pi 先升到目标版（探针直接 spawn PATH 上的 pi），
   `probe-shell` / `probe-plan` / `probe-watchdog` 全绿才继续。
   扩展兼容性在这一步现形，改动零成本。
4. **改钉版** — 三个文件 + `pnpm install` 更新锁。
5. **重建模板** — 两个 E2B 模板都重建（镜像里的 pi 就是这一步换掉的）。
6. **全链路门禁** — `test:e2e` / `test:shell` / `test:plan` / `test:chaos` 全绿才算完。

任何一步失败：钉版不落地（第 3 步前）或明确报出「镜像已重建但有回归」，
由人决定修复还是回退 —— 不存在静默升上去的状态。

本机开发模式（`AGENT_RUNTIME_URL`）跑的是 PATH 上的 pi，和镜像版本是两回事；
探针恰好利用这一点，让本机先当小白鼠。

## 11. 认证与多用户（InsForge）

认证外包给 InsForge（评估与分工见 `docs/04-insforge-backend.md`）：OAuth 应用、
用户库、令牌签发都在后端；**开关由环境变量驱动** —— 前端不配
`NEXT_PUBLIC_INSFORGE_URL` 就是开放模式（本地开发、全部测试脚本不受影响），
socket-server 不配 `INSFORGE_URL` 同理。两侧独立开关，各自默认开放。

```
浏览器                Next.js :3000                  socket-server :4000
  │  1. OAuth 登录（@insforge/sdk，PKCE）               │
  │ ──────────────────► InsForge 后端 ◄── OAuth 应用在 dashboard 配
  │  2. getCurrentUser() 恢复会话（httpOnly refresh cookie）
  │     getValidAccessToken() 取 handshake 安全的 accessToken
  │  3. io(url, {auth:{token}}) + Bearer 头            │
  │ ─────────────────────────────────────► io.use 内省 → socket.data.userId
  │                                        每个 handler / HTTP 端点做属主校验
```

要点：

- **内省，不本地验签。** 令牌是 InsForge 签的 RS256 用户 JWT；socket-server
  调 `GET /api/auth/sessions/current` 验（60s 缓存），验不过的代价最多是
  60s 宽限。不本地验签的原因：公钥在后端手里，而且验签看不出「已登出」。
- **属主校验按「不存在」处理。** 别人的会话 join / steer / 文件端点一律 404，
  不报 403 —— 不暴露会话是否存在（防枚举）。
- **迁移决策：存量封存。** 鉴权引入前的会话 `user_id = NULL`，对所有人不可见；
  开放模式下照旧全部可见（`listSessions(undefined)` 不过滤），行为零变化。
- **令牌过期自愈。** 控制面拒连（`unauthorized`）→ 前端重取 accessToken
  （SDK 自动刷新）→ 重挂载 Workspace 换新连接。
- **多用户隔离只到数据层。** 模型 key 仍是平台级共享（沙箱里 pi 用的是部署方
  统一配的 key），按用户配额 / 自带 key 和成本计量一起留作后续。
- e2e 锁死：`scripts/e2e-auth.mjs` 自起带鉴权的控制面（独立端口、独立 DB），
  用 InsForge 真实测试用户令牌断言：无令牌/假令牌被拒、列表隔离、join 被拒、
  文件端点 401/404、登录态下完整链路照常。`test:auth:pg` 是同套断言的
  Postgres 变体（生产同款存储路径，跑完自清测试数据）。

## 12. 存储：SQLite 开发 / Postgres 生产

同一张 `Store` 接口两个实现（`socket-server/src/store*.ts`），env 驱动：
配了 `DATABASE_URL` 就是 `PgStore`（生产，InsForge Postgres），否则
`SqliteStore`（本地开发，零外部服务）。选择发生在启动时，代码路径不分叉。

两个实现必须一致的语义（写在 store.ts 的接口注释里，防漂移）：

- **客户端持游标，服务端无状态。** 重连补差集：SQLite 按 `(ts, rowid)` 定位
  游标，PG 按 `(ts, seq)`（seq 是 identity 列，替代 rowid 做同毫秒裁决）；
  游标不存在退化成全量（宁可重发不可丢历史）。
- **upsert 收敛。** 同 id 事件主键冲突就地替换（流式消息、工具进展）。
- **append 是同步外观。** 事件管线不等写库：SQLite 本就同步；PG 内部一条
  串行 Promise 队列保序，写失败只记日志 —— 事件已广播给在线客户端，
  写库失败不该炸实时链路。

PG 侧的两个设计决策：

- **users 表没了。** SQLite 时代的 users 表只写不读（连接时 upsert，从不查询），
  用户档案以 InsForge `auth.users` 为准；`sessions.user_id` 直接外键过去。
- **RLS 是第二道防线，不是唯一防线。** socket-server 用 service 连接直连
  （RLS 不生效），属主强制点仍是应用层的 owns/guardHttp；表上的 RLS 策略
  （`auth.uid()` 属主可见）管的是 PostgREST 直连路径 —— 前端将来直接查库
  时天然只能碰到自己的行。

表结构迁移在 `migrations/`（InsForge CLI 管理）；存量数据迁移脚本是
`scripts/migrate-sqlite-to-pg.mjs`（幂等，ON CONFLICT DO NOTHING）。

## 13. 成本与积分（商业化）

平台对每一次 agent 运行的真实成本是**精确可计**的，收费模型建立在这上面：

**定价。** 1 积分 = $0.01 面值；扣积分 = `ceil(pi 真实成本 × 100 × 倍率)`，
倍率默认 2（`CREDIT_MARKUP`）。E2B 算力/带宽/支付通道费不单独拆账，
由倍率统一覆盖 —— 账本里只有一条成本线，用户和运营都看得懂。

**计量链路。** pi 的 `agent_end` 自带本轮完整 usage/cost（turn 级，非累积，
逐条 assistant 消息求和不重复计）。agent-runtime 把它翻成 `usageReport`
事件入事件流（持久化不渲染）；socket-server 广播前把按当时倍率换算好的
积分写进事件的 `credits` 字段 —— 历史事件永远反映扣费那一刻的真实数字，
倍率调了也不回头改账。

**账本。** `credit_ledger` 是唯一事实来源，`wallets.balance` 是它的物化缓存。
每次变动同事务写 ledger + 更新 wallet；入账类操作（trial/purchase/adjust）
靠 `UNIQUE(user_id, reason, ref)` 幂等 —— webhook 重发、重试、重放都不会
二次入账。扣费允许透支到负数（turn 结束才知道成本），拦截在「发消息前」做。

**三道闸。**
1. **耗尽硬停止**：`send_message`/`steer` 前查余额，≤0 拒投并回
   `statusUpdate(code=insufficient_credits)` —— 前端凭 code 顶开充值弹框，
   不匹配文案（i18n 安全）。进行中的 turn 跑完，不腰斩。
2. **会话预算保险丝**：单会话累计 `SESSION_CREDIT_CAP`（默认 500）到顶，
   abort 当前 turn + 事件告知。失控循环（agent 自我拉扯）的成本天花板。
3. **运行中零事件兜底**：`STUCK_RUN_MS`（3h）强制收尾 —— 见 §9，成本
   治理上线前就有，现在是第三道闸。

**支付（waffo）。** 托管收银台：前端 `create_checkout` → 本地落 pending
订单（id 进 checkout metadata 当幂等纽带）→ 拿 checkoutUrl 新标签打开。
支付成功 waffo 打 `POST /webhooks/waffo` —— **raw body 验签**（SDK 内置
test/prod 公钥），先 200 再异步入账；`completeOrder` 的「pending 才翻转」
兜住 webhook 重放。测试模式全链路用测试卡（`4576750000000110` 成功 /
`4576750000000220` 拒付），上生产 = 产品 publish + 换生产凭证，代码零改动。

**存储账单。** paused 沙箱的快照一直占 E2B 存储配额。
`scripts/sandbox-storage-report.mjs` 每日对账：DB 无会话认领的孤儿沙箱
（删会话时 kill 失败的漏网）→ kill；paused 超 `SANDBOX_MAX_AGE_DAYS`
（默认 30 天）→ kill。getMetrics 只覆盖运行中沙箱，报告以数量×状态×
年龄为准。沙箱创建时打 `metadata:{app, sessionId}`，对账不靠猜。

**开关。** `creditsEnabled = INSFORGE_URL 已配`（有用户概念才有积分可扣）。
纯本地开放模式整个治理层静默关闭，行为与引入前完全一致。
`CREDITS_DEBUG=1` 才注册 `debug_grant` 后门（e2e 用）—— 生产绝不设。
