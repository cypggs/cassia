# MCP 接入设计(2026-10-16)

> pi 1.x 内置了 MCP client(`mcp.json` + OAuth + `--no-mcp`/`--tools` 通配)。
> 本文决定 Cassia 怎么用它。原则不变:我们是连接器,不造工具协议;
> 能复用 pi 原生机制就不写自己的代码。

## 问题

沙箱里的 agent 目前只有内置工具(read/bash/edit/write)+ 我们的两个扩展
(plan/persistent-shell)。接外部能力(数据库、内部 API、浏览器服务)的
标准通道是 MCP。没有它,用户想让 agent 连自己的服务就得在会话里手把手
教 agent 调 curl —— 每次会话重复,且凭证散落在对话里。

## 关键判断

1. **一个沙箱 = 一个会话**(现有架构)。所以「用户级」和「项目级」
   mcp.json 的区分对我们没意义 —— 整个沙箱就是这个会话的。
   直接写 `~/.pi/agent/mcp.json`(用户级),不碰项目级覆盖机制。

2. **配置不进镜像**。和 provider key 同一条纪律:镜像里没有任何
   凭证/环境特异的配置。MCP 配置由控制面在 provision 时写入沙箱。

3. **写入通道已经存在**。`RuntimeHandle.writeFile`(本地模式直写
   WORKSPACE,e2b 模式走 `sbx.files.*`)—— 附件通道用的就是它。
   MCP 配置只是又一个文件,不需要新机制。

4. **stdio 和远程 MCP 都允许**。沙箱本身就是隔离边界;stdio server
   用 `npx <pkg>` 起,不用改镜像;远程 server 走 URL+OAuth/token。
   pi 负责进程生命周期,快照暂停/唤醒随沙箱走。

5. **v1 不做 UI**。会话装了哪些 MCP 先只体现在工具时间线上
   (mcp 工具调用走 `tool_execution_*`,translate.ts 已兜底成
   `other` 类型渲染)。专门的「MCP 面板」等真有第二个用户问起再说。

## v1 方案(约 20 行)

```
控制面 .env:  MCP_SERVERS='{"db":{"command":"npx","args":["-y","@x/mcp-db"],
                              "env":{"PGURL":"..."}},
                              "api":{"url":"https://mcp.example.com/sse"}}'
                     │
provision 时(沙箱健康检查后、attach 前)
                     ▼
沙箱 ~/.pi/agent/mcp.json  ←  sbx.files.write(原文透传,格式归 pi 管)
                     │
pi 启动(--no-extensions 不影响 MCP;MCP 是 pi 内核管的,不是扩展)
                     ▼
mcp__db__query 等工具进入 tool_execution_* 事件流
                     ▼
translate.ts 已兜底:toolUsed{tool:'other', detail.other.payload}
```

- **不配 `MCP_SERVERS` = 完全不写文件 = 行为与现在一致**(零 if 在主链路:
  provision 里一个 `if (mcpJson) await handle.writeFile(...)` 是唯一的分叉,
  与 `PI_TOOLS_ADJUST` 同款)
- **格式校验归 pi**:我们不解析 mcp.json,写错 pi 会在日志里喊,
  agent 看到工具不在会自己换路 —— 不造校验层
- **凭证在控制面 env**:JSON 里的 secret 值只在 .env / .env.production,
  经 writeFile 落到会话沙箱内部,不进 git、不进镜像、不过前端

## 明确不做

- **不做 per-session 配置**:v1 全平台同一份。一个沙箱一个会话的架构下,
  per-session 的差异化配置是真需求出现时再加(那时配置从控制面 env
  挪到会话创建参数,writeFile 通道不变)
- **不做 MCP server 的托管/编排**:它们是沙箱内的进程或外部服务,
  生死由 pi 和对方负责
- **不做 OAuth 交互流程**(v1):需要浏览器跳转的 MCP server 在
  headless 沙箱里走不通;v1 只支持 token/无认证的 server。
  OAuth 需求来了再评估 pi 的 CIMD(native client)路径

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| MCP server 拖慢 pi 启动(连接超时) | pi 对 MCP 连接有超时;控制面 provision 不等 MCP 就绪,agent 可用即可 |
| 恶意/失控 MCP server 烧 token | 与 bash 同级风险,已有三道闸(余额/会话预算/僵死安全带) |
| mcp.json 写坏导致 pi 起不来 | watchdog 自愈会重起 pi;配置错误会在 pi stderr 里现形(已进日志) |

## 验证

1. 本地:`.env` 配一个公开 MCP(如 `npx -y @modelcontextprotocol/server-everything`?no —— 用最小的真实 server),create session → 问 agent「你有哪些工具」→ 时间线出现 `mcp__` 前缀的 toolUsed
2. `PI_TOOLS_ADJUST='-mcp__*'`(负向通配)应能整体关掉 —— 验证 `--no-mcp` 等效路径
3. chaos 回归不动(MCP 未配置时零影响)
