/**
 * pi 扩展：plan 工具 —— 让模型把「任务计划」结构化地报给平台。
 *
 * 背景：pi 0.82.1 没有内置 todo/plan 工具（翻遍 dist 确认过），
 * 但平台的计划面板需要一个全量快照数据源。这个工具就是那个数据源：
 * 模型每调一次，args 就是一份完整的计划清单，translate.ts 把它翻成
 * planUpdate 事件推给前端。
 *
 * 设计取舍：
 * - **永远全量**。模型只交完整列表，不做增量操作（add/complete/...）。
 *   增量协议在 LLM 手里必然漂移，全量快照错了下次调用自然纠正。
 * - **状态机在最简单的层面卡住**：任何时刻最多一个 in_progress，
 *   违反就报错让模型重交 —— 比在翻译层猜它的意思强。
 * - execute 本体几乎什么都不做：计划是给平台和用户看的，模型需要的
 *   只是一句确认。真正的价值在 tool_execution_start 的 args 里。
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

const STATUSES = ['pending', 'in_progress', 'completed', 'failed'] as const

const parameters = Type.Object({
  tasks: Type.Array(
    Type.Object({
      title: Type.String({ description: '步骤的一句话描述（用用户的语言）' }),
      status: Type.Union(STATUSES.map((s) => Type.Literal(s))),
    }),
    { minItems: 1, description: '完整步骤列表（全量提交，不是增量）' },
  ),
})

type PlanParams = { tasks: { title: string; status: (typeof STATUSES)[number] }[] }

export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'plan',
    label: '更新任务计划',
    description:
      '维护当前任务的步骤计划，让用户实时看到进度。' +
      '凡是需要 3 步以上的任务：开始时先调用本工具建立完整计划；每完成或失败一步，' +
      '立即再次调用更新状态并把下一步置为 in_progress。' +
      '永远提交完整列表（全量，不是增量）。任何时刻最多一个 in_progress。',
    promptSnippet: 'plan: 建立/更新任务的步骤计划（3 步以上的任务必用，全量提交）',
    promptGuidelines: [
      '3 步以上的任务：先调 plan 建完整步骤列表，再开始执行',
      '每完成一步立即调 plan 更新：该步置 completed（失败置 failed），下一步置 in_progress',
      '任何时刻最多一个 in_progress；计划有变化就整体重发完整列表',
    ],
    parameters,
    async execute(_toolCallId, params: PlanParams) {
      const doing = params.tasks.filter((t) => t.status === 'in_progress')
      if (doing.length > 1) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `计划被拒：同时有 ${doing.length} 个 in_progress 步骤（${doing.map((t) => t.title).join('、')}）。任何时刻只能有一个，请修正后重新提交完整列表。`,
            },
          ],
          details: { rejected: true },
        }
      }
      const done = params.tasks.filter((t) => t.status === 'completed').length
      const current = doing[0]?.title ?? '无（全部待办或已完成）'
      return {
        content: [
          {
            type: 'text' as const,
            text: `计划已更新：共 ${params.tasks.length} 步，已完成 ${done} 步，当前：${current}`,
          },
        ],
        details: { tasks: params.tasks },
      }
    },
  })
}
