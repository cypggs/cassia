/**
 * 平台事件模型。
 *
 * 三条不变量，前端所有渲染逻辑都建立在它们之上：
 *
 * 1. **双表示**：`toolUsed` 同时带 `message`（给中间栏的对话气泡，人话）
 *    和 `detail`（给右侧面板的结构化原始数据）。前端永远不用从原始输出反推摘要。
 * 2. **显示与持久化正交**：`noRender` 和 `noPersistent` 是两个独立布尔量。
 *    `liveStatus`（"思考中"）是 noPersistent 但要渲染；某些内部 statusUpdate
 *    是要存但不渲染。混成一个枚举就会在某个组合上卡住。
 * 3. **planUpdate 是全量快照**，不是增量。前端直接替换整个列表，
 *    不需要维护 reducer，也就不会因为丢一条事件而永久错位。
 */

export type AgentStatus = 'running' | 'stopped' | 'failed'
export type ToolStatus = 'running' | 'success' | 'error'
export type PlanTaskStatus = 'todo' | 'doing' | 'done' | 'failed'

export interface EventBase {
  /** 22 位 nanoid，同时充当客户端续传游标 */
  id: string
  timestamp: number
  /** 存但不显示 */
  noRender?: boolean
  /** 显示但不存盘（如 liveStatus） */
  noPersistent?: boolean
  /** 回指所属计划步骤，中间栏据此天然分组 */
  planStepId?: string
}

// ── 对话 ────────────────────────────────────────────────────────────

export interface ChatEvent extends EventBase {
  type: 'chat'
  sender: 'user' | 'assistant'
  messageType: 'text'
  content: string
  /** 用户随消息上传的附件。path 是会话工作目录内的相对路径（uploads/...） */
  attachments?: { name: string; path: string; size: number }[]
}

/** Agent 对当前进展的自述，在计划步骤之间承上启下 */
export interface ExplanationEvent extends EventBase {
  type: 'explanation'
  content: string
  status: 'start' | 'end'
}

// ── 工具 ────────────────────────────────────────────────────────────

export type ToolName = 'terminal' | 'textEditor' | 'browser' | 'search' | 'other'

export interface TerminalDetail {
  action: 'execute'
  /** 终端 tab 的键。持久 shell 落地后恒为 'main'，字段留给未来多 shell 并行 */
  shellId: string
  command: string
  /** append = output 是要追加的增量；replace = 全量覆盖 */
  outputType: 'append' | 'replace'
  /** 保留 ANSI 转义序列，前端直接 write 进 xterm.js */
  output: string[]
  finished: boolean
  exitCode?: number
}

export interface TextEditorDetail {
  action: 'view' | 'create' | 'edit'
  path: string
  content?: string
  oldContent?: string
}

export interface BrowserDetail {
  action: 'navigate' | 'click' | 'input' | 'screenshot'
  url?: string
  title?: string
}

export interface GenericDetail {
  action: string
  payload?: unknown
}

export type ToolDetail =
  | { terminal: TerminalDetail }
  | { textEditor: TextEditorDetail }
  | { browser: BrowserDetail }
  | { other: GenericDetail }

export interface ToolUsedEvent extends EventBase {
  type: 'toolUsed'
  /** 同一次工具调用的所有事件共享它 —— 前端据此就地更新而非追加 */
  actionId: string
  tool: ToolName
  status: ToolStatus
  /** 一句话意图，用户语言。见 agent-runtime/src/translate.ts 的生成策略 */
  brief?: string
  description?: string
  /** 给中间栏 */
  message: { action: string; param?: string }
  /** 给右侧面板 */
  detail?: ToolDetail
  /** 执行耗时毫秒(pi 1.1+ 的 tool_execution_end 带来),只在终态事件上有 */
  durationMs?: number
}

// ── 计划 ────────────────────────────────────────────────────────────

export interface PlanTask {
  title: string
  status: PlanTaskStatus
  startedAt?: number
  endAt?: number
}

/** 全量快照，前端直接替换 */
export interface PlanUpdateEvent extends EventBase {
  type: 'planUpdate'
  tasks: PlanTask[]
}

export interface NewPlanStepEvent extends EventBase {
  type: 'newPlanStep'
  stepId: string
  title: string
}

// ── 状态 ────────────────────────────────────────────────────────────

export interface StatusUpdateEvent extends EventBase {
  type: 'statusUpdate'
  agentStatus: AgentStatus
  brief?: string
  description?: string
  /** 机器可读的分类码（积分拦截等）—— 前端凭它分支，不匹配文案 */
  code?: string
}

/** 高频、易失。noPersistent 恒为 true —— 不污染历史 */
export interface LiveStatusEvent extends EventBase {
  type: 'liveStatus'
  text: string
}

export interface SandboxUpdateEvent extends EventBase {
  type: 'sandboxUpdate'
  sandboxId: string
  /** paused = 休眠（快照保留，不计费），下次活跃时恢复，文件和进程状态都在 */
  status: 'starting' | 'running' | 'paused' | 'stopped'
  /** 浏览器直连沙箱，控制面不中转视频流 */
  vncUrl?: string
  webRTCUrl?: string
}

/**
 * 一次 agent 运行（pi agent_end）的用量汇总 —— 成本计量的唯一数据源。
 * noRender：不在消息流占位置；但要持久化，扣费对账靠它。
 * 数值是本轮新增（pi 的 messages 是 turn 级的，不是累积），可直接求和。
 */
export interface UsageReportEvent extends EventBase {
  type: 'usageReport'
  model?: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** 美元。pi 按模型价目表算的真实成本（usage.cost.total 之和） */
  costUsd: number
  /**
   * 这一轮实际扣的积分 —— socket-server 广播前按当时倍率换算填入，
   * 随事件持久化。前端展示一律用这个快照，不自己换算（倍率可调，
   * 历史事件必须反映扣费那一刻的真实数字）
   */
  credits?: number
}

export type AgentEvent =
  | ChatEvent
  | ExplanationEvent
  | ToolUsedEvent
  | PlanUpdateEvent
  | NewPlanStepEvent
  | StatusUpdateEvent
  | LiveStatusEvent
  | SandboxUpdateEvent
  | UsageReportEvent

export type AgentEventType = AgentEvent['type']

// ── 会话 ────────────────────────────────────────────────────────────

export interface SessionSummary {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  agentStatus: AgentStatus
  sandboxId?: string
  /** 置顶时间（ms epoch）；未置顶没有此字段。列表按 置顶优先 + updatedAt 排序 */
  pinnedAt?: number
}

// ── 传输封装 ────────────────────────────────────────────────────────

/** 事件在 Socket.IO 上的信封 */
export interface EventEnvelope {
  sessionId: string
  event: AgentEvent
}

/** 客户端 join_session 的入参 —— lastMessageId 是续传游标 */
export interface JoinSessionPayload {
  sessionId: string
  lastMessageId?: string
}

export interface JoinSessionAck {
  sessionId: string
  events: AgentEvent[]
  session: SessionSummary
  /** 拒绝原因（不存在/无权访问）。有 error 时 events 为空 */
  error?: string
}

export function isPersistent(e: AgentEvent): boolean {
  return e.noPersistent !== true
}
