import { nid } from '@cassia/shared'
import type {
  AgentEvent,
  PlanTaskStatus,
  ToolDetail,
  ToolName,
  ToolUsedEvent,
} from '@cassia/shared'
import type { PiEvent } from './pi-client.js'

/**
 * pi 事件 → 平台事件。
 *
 * 这一层是整个平台唯一需要跟 pi 版本耦合的地方，所有 pi 特有的形状都止步于此。
 * 映射依据是实测采集的事件流（scripts/probe-pi.mjs），不是文档推测 ——
 * 两处与直觉相反、值得留意：
 *
 * 1. `tool_execution_update.partialResult` 是**累积快照**（长度单调增长），
 *    不是增量。要还原成 append 流必须自己做前缀 diff。
 * 2. `bash_execution_update.delta` 才是真增量，但它**只在宿主直接调
 *    `{type:'bash'}` 时触发**，模型自己调 bash 工具时不走这条。
 *
 * 已知缺口：pi 的 bash 每次都是全新 shell，cwd 和环境变量不跨调用存活。
 * 具名持久 PTY（shellId 共享上下文）在 pi 里没有对等物，
 * 因此 P0 的 shellId 恒为 'main'。见 README 的「已知限制」。
 */

const MAIN_SHELL = 'main'

/**
 * 文件内容快照的上限。整个文件塞进事件流既撑爆 SQLite，
 * 也会让 Socket.IO 的每帧变大 —— 面板看个大概就够，
 * 真要看全文用户可以叫 Agent 读给他。
 */
const CONTENT_CAP = 20_000

function cap(s: string): string {
  return s.length > CONTENT_CAP ? s.slice(0, CONTENT_CAP) + '\n…(截断)' : s
}

/** pi 工具名 → 右侧面板的 tab 类型 */
function toolNameOf(piTool: string): ToolName {
  switch (piTool) {
    case 'bash':
      return 'terminal'
    case 'read':
    case 'write':
    case 'edit':
    case 'multi_edit':
      return 'textEditor'
    case 'web_search':
    case 'web_fetch':
      return 'search'
    default:
      return 'other'
  }
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text?: unknown }).text ?? '') : ''))
    .join('')
}

/**
 * 人话摘要。P0 用确定性规则生成，不额外调模型。
 *
 * 更优的 brief 是 LLM 用用户语言写的，信息量更高（"检查 /tmp 目录下的文件
 * 以确认下载是否成功" vs 这里的 "执行命令"）。升级路径见 README §brief 生成。
 */
function briefOf(piTool: string, args: Record<string, unknown>): { action: string; param?: string } {
  switch (piTool) {
    case 'bash':
      return { action: '执行命令', param: String(args.command ?? '') }
    case 'read':
      return { action: '读取文件', param: String(args.path ?? args.file_path ?? '') }
    case 'write':
      return { action: '写入文件', param: String(args.path ?? args.file_path ?? '') }
    case 'edit':
    case 'multi_edit':
      return { action: '编辑文件', param: String(args.path ?? args.file_path ?? '') }
    case 'web_search':
      return { action: '搜索', param: String(args.query ?? '') }
    case 'web_fetch':
      return { action: '访问网页', param: String(args.url ?? '') }
    default:
      return { action: piTool }
  }
}

interface ToolState {
  piTool: string
  tool: ToolName
  args: Record<string, unknown>
  /** 已经推给前端的输出长度 —— 前缀 diff 的游标 */
  sentLen: number
}

export class Translator {
  private tools = new Map<string, ToolState>()
  private assistantMsgId: string | null = null
  private assistantSent = ''
  /** 当前计划步骤，过程事件回指它 */
  private planStepId: string | undefined
  /** 上一份计划快照里 doing 步骤的标题 —— 变了才发 newPlanStep */
  private lastDoingTitle: string | undefined

  setPlanStep(id: string | undefined) {
    this.planStepId = id
  }

  translate(ev: PiEvent): AgentEvent[] {
    switch (ev.type) {
      case 'agent_start':
        return [this.status('running', 'Agent 开始工作')]

      case 'agent_settled':
        this.assistantMsgId = null
        this.assistantSent = ''
        return [this.status('stopped', 'Agent 已完成工作')]

      case 'message_start':
        return this.onMessageStart(ev)

      case 'message_update':
        return this.onMessageUpdate(ev)

      case 'message_end':
        return this.onMessageEnd(ev)

      case 'tool_execution_start':
        return this.onToolStart(ev)

      case 'tool_execution_update':
        return this.onToolUpdate(ev)

      case 'tool_execution_end':
        return this.onToolEnd(ev)

      case 'bash_execution_update':
        return this.onHostBashDelta(ev)

      case 'agent_end':
        return this.onAgentEnd(ev)

      default:
        // turn_start / turn_end / response 不产出面向用户的事件
        return []
    }
  }

  /**
   * agent_end 的 messages 是本轮新增（turn 级，非累积），逐条 assistant
   * 消息的 usage 求和就是这一轮的真实成本 —— 成本计量的唯一数据源。
   * 事件持久化但不渲染（noRender），socket-server 看到它执行扣费。
   */
  private onAgentEnd(ev: PiEvent): AgentEvent[] {
    const messages = Array.isArray(ev.messages) ? ev.messages : []
    let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, costUsd = 0
    let model: string | undefined
    for (const m of messages) {
      const msg = m as { role?: string; model?: string; usage?: {
        input?: number; output?: number; cacheRead?: number; cacheWrite?: number
        cost?: { total?: number }
      } }
      if (msg.role !== 'assistant' || !msg.usage) continue
      input += msg.usage.input ?? 0
      output += msg.usage.output ?? 0
      cacheRead += msg.usage.cacheRead ?? 0
      cacheWrite += msg.usage.cacheWrite ?? 0
      costUsd += msg.usage.cost?.total ?? 0
      if (msg.model) model = msg.model
    }
    // 全零（比如纯失败重试的空轮）就不发 —— 没有成本就没有要计的
    if (!input && !output && !costUsd) return []
    return [
      {
        id: nid(),
        type: 'usageReport',
        timestamp: Date.now(),
        noRender: true,
        model,
        input,
        output,
        cacheRead,
        cacheWrite,
        costUsd,
      },
    ]
  }

  // ── 消息 ──────────────────────────────────────────────────────────

  private onMessageStart(ev: PiEvent): AgentEvent[] {
    const msg = ev.message as { role?: string } | undefined
    if (msg?.role !== 'assistant') return []
    this.assistantMsgId = nid()
    this.assistantSent = ''
    return []
  }

  /**
   * 用累积文本做 upsert：同一条 assistant 消息始终用同一个事件 id，
   * 前端按 id 覆盖而不是追加。比传增量简单，也不怕丢包错位。
   */
  private onMessageUpdate(ev: PiEvent): AgentEvent[] {
    const msg = ev.message as { role?: string; content?: unknown } | undefined
    if (msg?.role !== 'assistant') return []
    const text = textOf(msg.content)
    if (!text || text === this.assistantSent) return []
    if (!this.assistantMsgId) this.assistantMsgId = nid()
    this.assistantSent = text
    return [
      {
        id: this.assistantMsgId,
        type: 'chat',
        timestamp: Date.now(),
        sender: 'assistant',
        messageType: 'text',
        content: text,
        planStepId: this.planStepId,
      },
    ]
  }

  private onMessageEnd(ev: PiEvent): AgentEvent[] {
    const msg = ev.message as { role?: string; content?: unknown } | undefined
    if (msg?.role !== 'assistant') return []
    const text = textOf(msg.content)
    const id = this.assistantMsgId ?? nid()
    this.assistantMsgId = null
    // 纯 toolCall 的 assistant 消息没有文本，不该在对话流里留空气泡
    if (!text.trim()) return []
    if (text === this.assistantSent) return []
    this.assistantSent = ''
    return [
      {
        id,
        type: 'chat',
        timestamp: Date.now(),
        sender: 'assistant',
        messageType: 'text',
        content: text,
        planStepId: this.planStepId,
      },
    ]
  }

  // ── 工具 ──────────────────────────────────────────────────────────

  private onToolStart(ev: PiEvent): AgentEvent[] {
    const id = String(ev.toolCallId)
    const piTool = String(ev.toolName)
    const args = (ev.args ?? {}) as Record<string, unknown>

    // plan 工具不是「动作」，是模型的计划快照 —— 进计划面板，不进工具时间线
    if (piTool === 'plan') return this.onPlanUpdate(args)

    const tool = toolNameOf(piTool)
    this.tools.set(id, { piTool, tool, args, sentLen: 0 })

    return [
      this.toolEvent(id, tool, 'running', briefOf(piTool, args), this.detailFor(piTool, args, '', false)),
    ]
  }

  /**
   * plan 工具的 args 就是全量计划快照（约定见 pi-extension/plan.ts）。
   * 翻译成 planUpdate；doing 步骤变了补一条 newPlanStep 并把后续事件
   * 的 planStepId 指过去 —— 中间栏按步骤分组靠的就是这个回指。
   *
   * 注意不在 this.tools 登记：onToolUpdate/onToolEnd 找不到状态自然丢弃，
   * plan 的执行结果（一句确认）不该在工具时间线留痕。
   */
  private onPlanUpdate(args: Record<string, unknown>): AgentEvent[] {
    const STATUS_MAP: Record<string, PlanTaskStatus> = {
      pending: 'todo',
      in_progress: 'doing',
      completed: 'done',
      failed: 'failed',
    }
    const raw = Array.isArray(args.tasks) ? args.tasks : []
    const tasks = raw.map((t) => {
      const task = t as { title?: unknown; status?: unknown }
      return {
        title: String(task.title ?? ''),
        status: STATUS_MAP[String(task.status)] ?? 'todo',
      }
    })
    if (!tasks.length) return []

    const out: AgentEvent[] = [
      {
        id: nid(),
        type: 'planUpdate',
        timestamp: Date.now(),
        tasks,
      },
    ]

    const doingIdx = tasks.findIndex((t) => t.status === 'doing')
    const doing = doingIdx >= 0 ? tasks[doingIdx] : undefined
    if (doing && doing.title !== this.lastDoingTitle) {
      this.planStepId = `step-${doingIdx}`
      out.push({
        id: nid(),
        type: 'newPlanStep',
        timestamp: Date.now(),
        stepId: this.planStepId,
        title: doing.title,
      })
    } else if (!doing) {
      this.planStepId = undefined
    }
    this.lastDoingTitle = doing?.title
    return out
  }

  private onToolUpdate(ev: PiEvent): AgentEvent[] {
    const id = String(ev.toolCallId)
    const st = this.tools.get(id)
    if (!st) return []

    const partial = ev.partialResult as { content?: unknown } | undefined
    const full = textOf(partial?.content)

    // 累积快照 → 增量。实测输出是只增的，按长度切就够。
    // 若长度回退（pi 截断了缓冲区），整段重发 —— 宁可重复不要错位。
    const delta = full.length >= st.sentLen ? full.slice(st.sentLen) : full
    if (!delta) return []
    st.sentLen = full.length

    return [
      this.toolEvent(id, st.tool, 'running', briefOf(st.piTool, st.args), this.detailFor(st.piTool, st.args, delta, false)),
    ]
  }

  private onToolEnd(ev: PiEvent): AgentEvent[] {
    const id = String(ev.toolCallId)
    const st = this.tools.get(id)
    if (!st) return []

    const result = ev.result as { content?: unknown } | undefined
    const full = textOf(result?.content)
    const delta = full.length >= st.sentLen ? full.slice(st.sentLen) : full
    const isError = ev.isError === true
    this.tools.delete(id)

    return [
      this.toolEvent(
        id,
        st.tool,
        isError ? 'error' : 'success',
        briefOf(st.piTool, st.args),
        this.detailFor(st.piTool, st.args, delta, true),
      ),
    ]
  }

  /** 宿主直接执行 bash 的真增量流 */
  private onHostBashDelta(ev: PiEvent): AgentEvent[] {
    const delta = String(ev.delta ?? '')
    if (!delta) return []
    return [
      this.toolEvent('host-bash', 'terminal', 'running', { action: '执行命令' }, {
        terminal: {
          action: 'execute',
          shellId: MAIN_SHELL,
          command: '',
          outputType: 'append',
          output: [delta],
          finished: false,
        },
      }),
    ]
  }

  // ── 构造 ──────────────────────────────────────────────────────────

  private detailFor(
    piTool: string,
    args: Record<string, unknown>,
    output: string,
    finished: boolean,
  ): ToolDetail {
    if (piTool === 'bash') {
      return {
        terminal: {
          action: 'execute',
          shellId: MAIN_SHELL,
          command: String(args.command ?? ''),
          outputType: 'append',
          output: output ? [output] : [],
          finished,
        },
      }
    }
    // 文件工具的「内容」在 args 里，不在工具输出里 ——
    // write 的输出只是一句确认，edit 的输出是 diff 统计。
    // 实测的 args 形状：write {path, content}；edit {path, edits:[{oldText,newText}]}
    if (piTool === 'write') {
      return {
        textEditor: {
          action: 'create',
          path: String(args.path ?? ''),
          content: cap(String(args.content ?? '')),
        },
      }
    }
    if (piTool === 'edit' || piTool === 'multi_edit') {
      const edits = Array.isArray(args.edits) ? args.edits : []
      const pick = (k: string) =>
        edits.map((e) => String((e as Record<string, unknown>)[k] ?? '')).join('\n')
      return {
        textEditor: {
          action: 'edit',
          path: String(args.path ?? ''),
          content: cap(pick('newText')),
          oldContent: cap(pick('oldText')),
        },
      }
    }
    if (piTool === 'read') {
      return {
        textEditor: {
          action: 'view',
          path: String(args.path ?? args.file_path ?? ''),
          // 只在结束时带内容 —— 中途的 partialResult 是残缺的文件前缀，
          // 流式推给文件面板没有意义
          content: finished ? cap(output) : undefined,
        },
      }
    }
    return { other: { action: piTool, payload: { args, output: output || undefined } } }
  }

  private toolEvent(
    actionId: string,
    tool: ToolName,
    status: ToolUsedEvent['status'],
    message: { action: string; param?: string },
    detail: ToolDetail,
  ): ToolUsedEvent {
    return {
      id: nid(),
      type: 'toolUsed',
      timestamp: Date.now(),
      actionId,
      tool,
      status,
      brief: message.param ? `${message.action}: ${message.param}` : message.action,
      message,
      detail,
      planStepId: this.planStepId,
    }
  }

  private status(agentStatus: 'running' | 'stopped' | 'failed', brief: string): AgentEvent {
    return {
      id: nid(),
      type: 'statusUpdate',
      timestamp: Date.now(),
      agentStatus,
      brief,
      planStepId: this.planStepId,
    }
  }
}
