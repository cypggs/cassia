# pi 1.x 特性评估(2026-10-16)

> 背景:Phase 2 已把 pi 0.87.1 → 1.2.0(pin 于 `agent-runtime/package.json` +
> 两个 e2b.Dockerfile)。本文评估 1.x 新能力对 Cassia 的价值,决定哪些跟进、
> 哪些搁置。信息来源:GitHub Releases v1.0.0–v1.2.0、pi 仓库 docs/。

## 结论速览

| 特性 | 版本 | 对 Cassia 的价值 | 决定 |
|---|---|---|---|
| MCP client | 1.0.x 起成熟 | 高 —— 沙箱内 agent 可接外部工具 | **跟进**(需设计) |
| Codemode | 1.0 精简 40% token,1.1 `+codemode` | 中高 —— 复杂多步任务省 token | **试点** |
| Virtual models | 1.x(extensions 注册) | 高 —— 官方版「按任务路由模型」 | **跟进**(替换规则路由) |
| Pi Durable | 独立包,experimental | 中 —— 与现有 watchdog 自愈重叠 | **搁置**(API 不稳) |
| `durationMs`(tool_execution_end) | 1.1.0 | 低但零成本 | **顺手接** |
| `before_agent_start` 扩展触发 run | 1.2.0 | 低 —— 目前无扩展自发 run | 知晓即可 |
| OSC 7501 程序状态 | 1.1.0 | 无(我们不跑 TUI) | 忽略 |
| `--tools` 模式/`*` 通配 | 1.0.4 | 低 —— 配合 MCP 白名单有用 | 随 MCP 一起 |

## 逐项分析

### 1. MCP client —— 建议跟进

pi 1.x 内置 MCP:`~/.pi/agent/mcp.json` 用户级 + `.pi/mcp.json` 项目级覆盖,
支持 OAuth(CIMD/native client)、`--no-mcp` 单次禁用、`--tools 'mcp__srv__*'`
通配筛选。

对 Cassia 的意义:沙箱里的 agent 目前只有 read/bash/edit/write + 我们的
plan/persistent-shell 扩展。MCP 是「给 agent 接外部能力」的标准通道(数据库、
浏览器、内部 API),不用自己造工具协议。

接入点(待设计文档,不在本文范围):
- 配置下发:session 工作目录放 `.pi/mcp.json`(每会话隔离),还是
  `~/.pi/agent/mcp.json`(镜像级全局)?倾向**会话级**,由控制面在
  provision 时写入,与 `attach` 下发 provider key 同一时机
- 密钥:MCP server 的 token 不能烤进镜像(同 provider key 原则),
  走 attach 下发或会话 env
- 风险:MCP server 运行在沙箱内,网络出站不受我们控制 —— 要在
  UI 上暴露「这个会话装了哪些 MCP」

### 2. Codemode —— 试点中(2026-10-16)

`pi -t +codemode` 即可叠加在默认工具上(1.1 起 `+name` 是增量语义)。
1.0 起 codemode prompt 减重 40%,错误信息会教模型自我恢复;支持
`models.classify()`(分类器)、`models.generateImages()`。

对 Cassia 的意义:多步批处理任务(如「处理这 50 个文件」)用 codemode
一个 JS 脚本跑完,比 50 次工具往返省大量 token 和时长。

**试点已落地**:`PI_TOOLS_ADJUST` 环境变量(agent-runtime → pi `--tools`,
socket-server 经 Sandbox.create envs 透传,默认空 = 行为不变)。
已在沙箱实测 pi 1.2.0 RPC 接受 `--tools +codemode`。
灰度步骤:模板重建带此改动 → 本地 chaos/e2e 带 `PI_TOOLS_ADJUST=+codemode`
回归(重点观察:模型会不会弃 bash 改用 codemode,e2e 的终端断言是否
还成立)→ 绿则在 .env.production 开启。

后续若转正:translate.ts 给 codemode 加专用 detail(代码块),而不是
走 `other` 的通用 payload。

### 3. Virtual models —— 建议跟进(中期)

扩展里 `pi.registerVirtualModel()` 注册一个「虚拟模型」,路由器按请求
映射到物理模型(如简单问题 → haiku,难问题 → sonnet)。选择(entry)与
派发(message)分离记录,会话恢复、compaction、成本统计都已处理好。

对 Cassia 的意义:商业化章节里「平台统一 key + 成本计量」如果想做
「按任务难度选模型控制成本」,virtual model 是官方机制,比自己在
translate 层做规则路由干净得多。`jev-router.ts` 是官方示例。

但依赖分类器/路由策略的设计,工作量大,排在 MCP 之后。

### 4. Pi Durable —— 搁置

`@earendil-works/pi-durable` 是程序化 harness(对话/turn/工具调用先落
存储再展示,进程死了重开续跑)。理念上与 Cassia 的 watchdog 自愈 +
`switch_session` 上下文重挂(架构文档 §9 事故 4)重叠。

不跟进的理由:
- 官方标注 **experimental,API 无预告变更**
- 它是嵌入式 SDK,不是 `pi --mode rpc` 子进程 —— 换它等于换掉
  agent-runtime 的整个驱动方式,重写 pi-client.ts + translate.ts
- 现有自愈已被 chaos 测试锁定,没有未解决的痛点

复查时机:pi-durable 摘掉 experimental,或我们遇到「watchdog 救不回来」
的真实事故。

### 5. 顺手可接的小改进

- **`durationMs`**(1.1.0,`tool_execution_end` 带来执行耗时):
  translate.ts 把它放进 toolUsed.detail,右栏可显示「耗时 3.2s」。
  零风险,一次提交的事。
- `before_agent_start` 对扩展触发 run 生效(1.2.0):如果将来 plan
  扩展要自发触发 turn,记得这个钩子已经统一了。

## 升级遗留确认

1.2.0 的 breaking changes(theme schema 迁移、MCP list 格式)经核对
不影响三个耦合点:
- `pi-extension/persistent-shell.ts`(createBashTool/BashOperations)
- `pi-extension/plan.ts`(ExtensionAPI/registerTool/TypeBox)
- `agent-runtime/src/pi-client.ts`(get_state/switch_session RPC 语义)

验证方式:模板重建后跑 `test:e2e` / `test:shell` / `test:plan` /
`test:chaos`(bump-pi 流程第 6 步门禁)。
