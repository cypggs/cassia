/**
 * 积分制成本治理 —— 换算与开关。
 *
 * 定价模型（已拍板）：
 *   1 积分 = $0.01 面值；扣积分 = ceil(模型成本 × 100 × 倍率)。
 *   倍率（默认 2）统一覆盖模型成本之外的 E2B 算力/带宽/支付通道费 ——
 *   E2B 时长费不单独拆账，混在倍率里。
 *
 * 模型成本口径（2026-08-17 起）：**不再信 pi 内置价目表**（它 bundling 的
 * deepseek 价是涨价前的旧价，曾低至官价 1/3，我们在倒贴）。改为按
 * usageReport 的 token 数 × 我们自己的官价表（MODEL_PRICES，跟着
 * https://api-docs.deepseek.com/zh-cn/quick_start/pricing/ 走）折算。
 * 表里没有的模型回退 pi 自报成本。
 *
 * DeepSeek 分高峰/空闲时段计价（北京时间**工作日** 9-12、14-18 为高峰，
 * 空闲半价；周末/法定节假日全天空闲）。扣费时刻落在哪个时段就按哪个价
 * —— 和上游账单同口径。
 *
 * 开关：creditsEnabled = 鉴权开启（INSFORGE_URL 已配）。有用户概念才有
 * 积分可扣；存储双实现（SQLite/PG）都带钱包表，本地鉴权开发同语义。
 * 开放模式（纯本地无登录）整个治理层静默关闭。
 *
 * 硬停止语义：拦截点在「发消息前」（余额 ≤0 拒投）；进行中的 turn 跑完，
 * turn 结束才知道成本，所以扣费允许小幅透支到负数 —— 下次发消息自然被拦。
 */

export const creditsEnabled = !!process.env.INSFORGE_URL

/** 新用户试用积分（io.use 里 ensureWallet 幂等发放，只发一次） */
export const TRIAL_CREDITS = Number(process.env.TRIAL_CREDITS ?? 100)

/** 单会话累计消耗上限。到顶自动 abort 当前 turn —— 失控循环的保险丝 */
export const SESSION_CREDIT_CAP = Number(process.env.SESSION_CREDIT_CAP ?? 500)

/** 模型成本 → 积分的倍率 */
const MARKUP = Number(process.env.CREDIT_MARKUP ?? 2)

/** 人民币 → 美元折算（DeepSeek 官价是人民币刊例）。偏保守取值，汇率波动走它 */
const CNY_PER_USD = Number(process.env.CREDIT_CNY_PER_USD ?? 7.2)

/**
 * 模型刊例价（人民币 / 1M tokens，**高峰价**；空闲时段官方半价）。
 * miss = 输入缓存未命中；hit = 输入缓存命中；out = 输出。
 * key 用模型 id 的最后一段（usageReport 的 model 可能是 deepseek/deepseek-flash）。
 */
const MODEL_PRICES: Record<string, { miss: number; hit: number; out: number }> = {
  // DeepSeek-V4.1-Flash（2026-09 官价）。旧 id deepseek-v4-flash 仍可调，
  // 官方说明同样由 V4.1-Flash 按 Flash 价服务 —— 两个 key 同价。
  'deepseek-flash': { miss: 2.0, hit: 0.04, out: 8.0 },
  'deepseek-v4-flash': { miss: 2.0, hit: 0.04, out: 8.0 },
  'deepseek-v4-pro': { miss: 9.0, hit: 0.3, out: 27.0 },
}

/**
 * 现在是不是 DeepSeek 的高峰计费时段：北京时间**工作日** 9:00-12:00、
 * 14:00-18:00；周末全天空闲价。中国法定节假日官方也算空闲，这里没接
 * 节假日表，节假日会按高峰多收一点（保守方向，不亏钱）。
 */
function isPeakHour(now = new Date()): boolean {
  const bj = new Date(now.getTime() + 8 * 3600_000)
  const day = bj.getUTCDay() // 北京时间星期几（0=周日）
  if (day === 0 || day === 6) return false
  const hour = bj.getUTCHours()
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18)
}

export interface UsageTokens {
  model?: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/**
 * 按 token 数和官价表算美元成本。表里没有的模型返回 null（调用方回退
 * pi 自报成本）。时段因子：空闲时段半价。
 */
export function officialCostUsd(u: UsageTokens): number | null {
  const key = u.model?.split('/').pop() ?? ''
  const price = MODEL_PRICES[key]
  if (!price) return null
  const cny =
    (u.input * price.miss + u.cacheRead * price.hit + u.cacheWrite * price.miss + u.output * price.out) / 1e6
  return (cny / CNY_PER_USD) * (isPeakHour() ? 1 : 0.5)
}

/**
 * 一轮 turn 的计费口径：官价表优先，pi 自报兜底。返回美元成本和应扣积分。
 * pi 自报成本目前（pi 0.83 捆绑的旧价目）显著低于官价 —— 表外模型才用它。
 */
export function priceUsage(u: UsageTokens, piCostUsd: number): { costUsd: number; credits: number; source: 'official' | 'pi' } {
  const official = officialCostUsd(u)
  const costUsd = official ?? piCostUsd
  return { costUsd, credits: Math.ceil(costUsd * 100 * MARKUP), source: official != null ? 'official' : 'pi' }
}

/** 美元成本 → 应扣积分。ceil：哪怕 $0.0001 也不能白用 */
export function creditsFor(costUsd: number): number {
  return Math.ceil(costUsd * 100 * MARKUP)
}

/** 事件里的「积分不足」标记 —— 前端凭 code 开充值弹框，不匹配文案 */
export const CODE_INSUFFICIENT = 'insufficient_credits'
/** 会话预算到顶 */
export const CODE_BUDGET_CAP = 'session_budget_cap'

