import type { AgentEvent, ToolUsedEvent } from '@cassia/shared'

/**
 * 历史压缩：会话全量加载（join 不带游标）时，把同一 actionId 的 toolUsed
 * 增量事件合并成一条。
 *
 * 为什么需要：终端输出是按 delta 流式落库的（outputType 'append'，每条只带
 * 一小段输出），一个长会话能攒上千条 toolUsed、几 MB payload —— 全量推给
 * 浏览器又慢又卡。合并后一次工具调用 = 一条事件，体积和事件数都降一个量级。
 *
 * 关键约定（破坏任何一个都会出 bug）：
 * - **位置取首条、id 取末条**。位置取首条保证时间线顺序不变（前端按 ts 排序）；
 *   id 取末条是为了断线游标 —— 客户端拿合并事件的 id 当 lastMessageId 续传时，
 *   服务端从该动作最后一个 delta 之后开始补，已合并的内容不会重放（终端会重影）。
 * - 终端输出合并后截尾（ELISION_CAP 字符/动作）：右侧面板的 xterm 重放只需要
 *   最近一屏多一点的滚动回溯，几 MB 的全量 scrollback 没有观看价值。
 * - 只用于「全量加载」。游标续传（断线重连补差集）必须拿原始增量，不能合并。
 */
export function compactHistory(events: AgentEvent[]): AgentEvent[] {
  const out: AgentEvent[] = []
  /** actionId → 已并入 out 的合并事件（就地 mutate，保持首次出现的位置） */
  const merged = new Map<string, ToolUsedEvent>()

  for (const e of events) {
    // 活状态（"思考中…"）没有历史价值，时间线本来也 skip
    if (e.type === 'liveStatus') continue
    if (e.type !== 'toolUsed') {
      out.push(e)
      continue
    }
    const prev = merged.get(e.actionId)
    if (!prev) {
      merged.set(e.actionId, e)
      out.push(e)
      continue
    }
    mergeToolInto(prev, e)
  }

  for (const e of merged.values()) capTerminal(e)
  return out
}

/** 把 next 并进 prev：状态/文案取最新，detail 按类型合并 */
function mergeToolInto(prev: ToolUsedEvent, next: ToolUsedEvent): void {
  prev.id = next.id // 游标取末条 —— 见函数头注释
  prev.status = next.status
  prev.message = next.message
  if (next.brief !== undefined) prev.brief = next.brief
  if (next.description !== undefined) prev.description = next.description
  if (next.noRender !== undefined) prev.noRender = next.noRender

  const pd = prev.detail
  const nd = next.detail
  if (!nd) return
  if (!pd) {
    prev.detail = nd
    return
  }
  if ('terminal' in pd && 'terminal' in nd) {
    pd.terminal.output = pd.terminal.output.concat(nd.terminal.output)
    pd.terminal.finished = nd.terminal.finished
  } else {
    // textEditor / browser / other：后者是全量快照语义，新的覆盖旧的
    prev.detail = nd
  }
}

/** 单个动作的终端输出截尾（按字符），保留开头标记被截过 */
const TERMINAL_CAP = 50_000

function capTerminal(e: ToolUsedEvent): void {
  const t = e.detail && 'terminal' in e.detail ? e.detail.terminal : null
  if (!t) return
  const total = t.output.reduce((s, c) => s + c.length, 0)
  if (total <= TERMINAL_CAP) return
  const joined = t.output.join('')
  const elided = joined.length - TERMINAL_CAP
  t.output = [`\x1b[2m… 早期输出已省略 ${elided} 字符 …\x1b[0m\r\n`, joined.slice(elided)]
}
