# pi RPC 协议（实测）

`pi --mode rpc` 的输入输出协议。以下全部来自实机采集（`scripts/probe-*.mjs`），
不是文档推测 —— 有两处与直觉相反，直接决定了 `agent-runtime/src/translate.ts` 的写法。

采集环境：pi `0.82.1`，模型 `deepseek/deepseek-v4-flash`。

---

## 1. 传输

stdin / stdout 各是一条 JSON 行流。字段名是 **`type`**，不是 `command` ——
发 `{"command":"prompt"}` 会得到 `Unknown command: undefined`。

stderr 只有告警噪音（比如 settings 里某个 thinking level 不认识），不参与协议。

```jsonc
// → stdin
{"type":"prompt","message":"帮我看看 /tmp 下有什么"}
// ← stdout
{"type":"agent_start"}
{"type":"turn_start"}
...
```

## 2. 命令集

```
prompt  steer  follow_up  abort  abort_bash  bash
new_session  switch_session  fork  clone  compact
set_model  cycle_model  set_thinking_level  set_steering_mode  set_follow_up_mode
get_state  get_messages  get_entries  get_tree  get_session_stats
get_available_models  get_available_thinking_levels  get_commands
get_fork_messages  get_last_assistant_text
set_session_name  set_editor_text  set_auto_compaction  set_auto_retry
export_html  notify  confirm  skill  extension_ui_response
```

平台真正用到的：

| 命令 | 用途 |
|---|---|
| `prompt` | 下发任务 |
| **`steer`** | 任务执行中途插话干预 —— pi 原生就有 |
| `abort` | 停止 |
| `bash` | 宿主直接执行命令（不经模型） |
| `fork` / `clone` | 从某一步分支重试（P2） |
| `compact` | 长任务上下文压缩（P2） |

## 3. 输出事件

```
response
agent_start  turn_start  turn_end  agent_end  agent_settled
message_start  message_update  message_end
tool_execution_start  tool_execution_update  tool_execution_end
bash_execution_update
```

### 3.1 两处反直觉的地方

**（一）`tool_execution_update.partialResult` 是累积快照，不是增量。**

实测一条 `for i in 1..6; do echo "tick $i"; sleep 1; done`：

```
+3.0s  tool_execution_start  {"toolName":"bash","args":{"command":"...","timeout":10}}
+3.0s  tool_execution_update  len=0
+3.0s  tool_execution_update  len=7    "tick 1\n"
+4.0s  tool_execution_update  len=14   "tick 1\ntick 2\n"
+5.0s  tool_execution_update  len=21   "tick 1\ntick 2\ntick 3\n"
...
+8.0s  tool_execution_update  len=42
+9.0s  tool_execution_end     len=42
```

好消息是**推送是真实时的**（每秒一次，和命令输出同步），坏消息是每次给的是
从头开始的全量。要还原成前端要的 append 流，必须自己按长度做前缀 diff。
`translate.ts` 用 `sentLen` 游标做这件事，长度回退时整段重发。

**（二）`bash_execution_update.delta` 是真增量，但只在宿主直接调 `bash` 时触发。**

```jsonc
{"type":"bash_execution_update","delta":"tick 1\n"}
{"type":"bash_execution_update","delta":"tick 2\n"}
{"type":"response","command":"bash","success":true,
 "data":{"output":"tick 1\n...","exitCode":0,"cancelled":false,"truncated":false}}
```

模型自己调 bash 工具时**不走这条**。所以两条路径要分别处理，
不能只实现其中一条就以为覆盖了。

### 3.2 消息事件

`message_update` 带两个字段：`assistantMessageEvent`（本次增量）和
`message`（累积到当前的完整消息）。

`assistantMessageEvent.type` 见过 `toolcall_start` / `toolcall_delta`，
文本走对应的 text 变体。`translate.ts` 不解析这一层，直接读 `message.content`
里的 text 块 —— 累积值做 upsert 比拼增量简单，也不怕丢包错位。

`message_start` / `message_end` 的 `message.role` 会是 `user` 或 `assistant`，
要过滤掉 user 的（那是 pi 在回放你自己发的 prompt）。

纯 toolCall 的 assistant 消息没有文本内容，不该在对话流里留空气泡。

### 3.3 结束

`agent_end` 带完整 `messages` 和逐条 `usage`（input/output/cacheRead/cacheWrite/cost），
是成本计量的现成入口。`agent_settled` 才是真正的「可以接受下一条输入了」。

---

## 4. 已知缺口（已补齐，见 §4.1）

**pi 的 bash 不是持久 shell。** 实测：

```
$ export PROBE_VAR=persisted; cd /tmp; pwd
/tmp
$ echo "VAR=[$PROBE_VAR] PWD=[$(pwd)]"
VAR=[] PWD=[<原工作目录>]
```

每次调用都是全新 shell，cwd 和环境变量不跨调用存活。

参考做法：runtime fork 出多个常驻 bash PTY，由 LLM 自己命名
（`shellId: "install_frpc_check"`），同一逻辑任务的命令共享上下文 ——
这在 pi 里没有对等物。

当前的处理：`shellId` 恒为 `'main'`，前端只开一个终端 tab。

要补齐有两条路，都是 P2：

1. **自己管 PTY**：agent-runtime 用 `node-pty` 起具名常驻 shell，
   通过 pi 的 extension 机制注册一个 `shell` 工具替换内置 bash。
   pi 支持 `--exclude-tools bash` + 自定义工具，接口是现成的。
2. **接受无状态**：在系统提示里要求模型把 cd/export 和后续命令写在同一条里。
   零成本，但把约束推给了模型，长任务里迟早出错。

倾向第 1 条 —— 「真终端」的体验差别就在这。

---

## 4.1 补齐：persistent-shell 扩展（已落地）

走了第 1 条路，但比设想的更巧：没有新写 `shell` 工具，而是用
`createBashTool(cwd, { operations })` **只替换内置 bash 的 exec 后端** ——
参数 schema、输出截断、流式 partialResult 全部保留 pi 内置实现，
唯一改变的是命令落在哪个 shell 里跑。实现见
`agent-runtime/pi-extension/persistent-shell.ts`，要点：

- 每个 pi 进程持有一个 node-pty 常驻 bash（`--norc -i`），命令串行执行。
- `stty -echo` 关掉回显。完成标记**不写 stdin**：由 `PROMPT_COMMAND`
  在命令结束后打印（`__PIDONE_<tag>_<序号>_<退出码>__`），PS1/PS2 置空。
  曾经把 printf 标记行追加在命令后面一起写入，实测 sudo 会清空 tty
  输入缓冲（安全设计），标记行被丢弃、命令永远等不到结束（线上事故）。
- 命令本体走**文件投递**（写临时脚本，终端里只发一行 `source <file>`）：
  多行命令直接写终端的话，heredoc 正文已在输入缓冲时 bash 不等整体
  输完就提前执行、提前打标记，一条调用产生多个标记，队列当场错位。
  文件投递后：一条调用 = 一行 = 一个标记。
- 标记带**序号**：脚本第一行设置 shell 变量 `__PI_SQ_<tag>=<n>`，
  PROMPT_COMMAND 展开它；扫描端只认当前命令的序号。被 Ctrl-C 杀掉的
  命令迟到的标记（exit=130）序号对不上，直接丢弃 —— 否则它会把队列里
  下一条命令提前 resolve 成 130（实测踩过）。
- 输出卫生是这块最容易踩坑的地方，四个实测问题及对策：
  1. 首条命令带回显/横幅 → spawn 后留 250ms 生效窗口，首条命令等它；
  2. 提示符行 → 按行正则剥除，无命令在跑时 buf 直接清空；
  3. heredoc 续行符 `> ` 在回显关闭后连写堆在输出最前面且被分包切开 →
     基于整个 buf 判「真实内容开始」，之前一律不发；
  4. **bash ≥5 的 bracketed-paste 转义**（`\x1b[?2004h/l`）→ 全局剥除，
     且转发时扣住末尾半个转义/半个标记的残段，防止切开后剥不掉。
- 流式不能被缓冲杀死：除上述残段外**不扣留**，输出即达即发
  （曾用 64 字节 hold-back，导致短输出命令完全失去增量）。
- shell 死亡（exit/崩溃）有恢复：下条命令重建新 shell，工具不永久卡死。

踩过的一个镜像构建坑：曾把全局 pi 软链进 `/opt/cassia/node_modules`，
npm arborist 会跟随软链「修剪」目标目录 —— 之后任何 `npm install`
都会把全局 pi 包清空（`spawn pi ENOENT`）。**不要软链**；
扩展对 pi 包的 import 由 pi 自己的加载器解析，不需要链。

模板里 node-pty 要现场编译（npm 包只带 darwin/win32 预编译产物），
build-essential 装在同一 RUN 层、编完当场卸掉。

验证：`node scripts/probe-shell.mjs`（本机 pi + 扩展，6 项断言）、
`npx tsx scripts/probe-unit-shell.mts`（直接驱动 PersistentShell：
基线 / sudo / heredoc / 超时 Ctrl-C / 超时后队列恢复 / stdin 管道）、
`node scripts/e2e-shell.mjs`（E2B 全链路，export/cd 跨调用存活）。
暂停/唤醒后 PTY 照常可用：`node scripts/probe-resume.mjs`。

浏览器脚本的一个坑也记在这里（不属于 shell 协议，但同为「命令挂死」）：
playwright `connectOverCDP` 会撑住 node 事件循环，脚本打印完输出也不退出，
命令挂到超时。BROWSER_PROMPT 已要求脚本结尾必须 `await browser.disconnect()`
（只断开连接，不动用户看着的浏览器；`browser.close()` 会杀掉它，仍然禁止）。

---

## 5. 复现

```bash
node scripts/probe-pi.mjs    # 模型驱动的完整一轮
node scripts/probe-pi2.mjs   # 宿主直接 bash：增量粒度 + shell 持久性
node scripts/probe-pi3.mjs   # 模型调 bash 的流式粒度
```
