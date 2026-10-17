'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

/**
 * 界面文案。默认英文（产品面向的外部用户先说英语），中文可选，
 * 选择存 localStorage。key 用「区域.语义」，en 文案本身当 key 的文档。
 *
 * 不加 i18n 库：文案就这么多，一个字典 + 一个 context 够了，
 * 多一层依赖换不来任何东西。
 */

/**
 * 部署方自己的客服邮箱：NEXT_PUBLIC_SUPPORT_EMAIL，未配则显示占位。
 * 页脚、法律页、充值失败提示都用这一个来源。
 */
export const SUPPORT_EMAIL =
  process.env.NEXT_PUBLIC_SUPPORT_EMAIL || 'support@example.com'

export type Lang = 'en' | 'zh'

const dict = {
  // ── 登录 ──
  'login.loading': { en: 'Loading…', zh: '载入中…' },
  'login.tagline': { en: 'A real computer for your agent', zh: '给 Agent 一台真实的电脑' },
  'login.github': { en: 'Continue with GitHub', zh: '使用 GitHub 登录' },
  'login.google': { en: 'Continue with Google', zh: '使用 Google 登录' },

  // ── 左侧栏 ──
  'nav.newTask': { en: 'New task', zh: '新任务' },
  'nav.empty': { en: 'No tasks yet', zh: '还没有任务' },
  'nav.connected': { en: 'Connected', zh: '已连接' },
  'nav.disconnected': { en: 'Disconnected', zh: '未连接' },
  'nav.signOut': { en: 'Sign out', zh: '退出' },
  'nav.pin': { en: 'Pin', zh: '置顶' },
  'nav.unpin': { en: 'Unpin', zh: '取消置顶' },
  'nav.rename': { en: 'Rename', zh: '重命名' },
  'nav.delete': { en: 'Delete', zh: '删除' },

  // ── 删除确认 ──
  'delete.title': { en: 'Delete this task?', zh: '删除这个任务？' },
  'delete.body': {
    en: 'The conversation, its history, and its sandbox — including any sleeping snapshot and everything installed in it — will be permanently deleted. This cannot be undone.',
    zh: '会话、事件记录和它的沙箱（包括休眠快照、里面装过的所有东西）都会被永久删除，无法恢复。',
  },
  'delete.cancel': { en: 'Cancel', zh: '取消' },
  'delete.confirm': { en: 'Delete', zh: '删除' },

  // ── 输入区 ──
  'composer.newFirst': { en: 'Give your agent a goal — sending starts a new task', zh: '给 Agent 一个目标 —— 发送即开始新任务' },
  'composer.steerPlaceholder': { en: 'Steer the agent…', zh: '插话干预…' },
  'composer.goalPlaceholder': {
    en: 'Give the agent a goal… (paste screenshots directly)',
    zh: '给 Agent 一个目标…（可直接粘贴截图）',
  },
  'composer.stop': { en: 'Stop', zh: '停止' },
  'composer.send': { en: 'Send', zh: '发送' },
  'composer.steer': { en: 'Steer', zh: '插话' },
  'composer.attachTitle': {
    en: 'Upload files for the agent (they land in uploads/ in the sandbox)',
    zh: '上传文件给 Agent（它会出现在沙箱的 uploads/ 目录）',
  },
  'composer.failed': { en: 'failed', zh: '失败' },
  'composer.remove': { en: 'Remove', zh: '移除' },
  'composer.autoText': { en: 'Please handle the files I uploaded.', zh: '请处理我上传的文件。' },
  'composer.pastedName': { en: 'pasted-image', zh: '粘贴图片' },

  // ── 时间线 ──
  'timeline.emptyTitle': { en: 'Give the agent a goal', zh: '给 Agent 一个目标' },
  'timeline.emptyBody': {
    en: 'It has a computer of its own — watch it work on the right.',
    zh: '它有一台自己的电脑，右侧能看到它在上面做什么。',
  },
  'timeline.running': { en: 'Running', zh: '执行中' },
  'timeline.failed': { en: 'Failed', zh: '失败' },
  'timeline.plan': { en: 'Plan', zh: '任务计划' },

  // ── 右侧计算环境 ──
  'tab.screen': { en: 'Screen', zh: '画面' },
  'tab.terminal': { en: 'Terminal', zh: '终端' },
  'tab.console': { en: 'Console', zh: 'Console' },
  'tab.files': { en: 'Files', zh: '文件' },
  'nav.collapse': { en: 'Collapse sidebar', zh: '收起侧边栏' },
  'nav.expand': { en: 'Expand sidebar', zh: '展开侧边栏' },
  'screen.sandboxId': { en: 'Sandbox ID', zh: '沙箱 ID' },
  'screen.emptyTitle': { en: 'No graphical environment in this run.', zh: '本次运行没有图形环境。' },
  'screen.emptyBody': {
    en: 'Start the sandbox with the "cassia" template and this panel connects straight to its VNC. Current template is set by E2B_TEMPLATE.',
    zh: '用 cassia 模板启动沙箱后，这里会直连沙箱的 VNC 显示浏览器画面。当前模板见 E2B_TEMPLATE。',
  },
  'screen.paused': {
    en: 'Asleep — send a message to wake it; the environment resumes as-is',
    zh: '已休眠 —— 发条消息唤醒，环境原样恢复',
  },
  'screen.connected': { en: 'Connected', zh: '已连接' },
  'screen.connecting': { en: 'Connecting…', zh: '连接中…' },
  'screen.reconnecting': { en: 'Disconnected, reconnecting…', zh: '已断开，重连中…' },
  'screen.takeover': { en: 'Take over', zh: '接管' },
  'screen.release': { en: 'Release', zh: '交还控制' },
  'screen.takeoverTitle': {
    en: 'Take over keyboard & mouse and operate this computer directly',
    zh: '接管键鼠，直接操作这台电脑',
  },
  'screen.releaseTitle': {
    en: 'Hand control back and return to view-only',
    zh: '交还控制权，回到只看模式',
  },
  'terminal.waiting': { en: 'Waiting for the agent to run commands…', zh: '等待 Agent 执行命令…' },
  'console.hint': {
    en: 'Your own shell in the sandbox — connected as the same user as the agent, files shared. Starting…',
    zh: '沙箱里的独立 shell —— 与 Agent 同一用户、文件互通。正在启动…',
  },
  'console.exited': {
    en: '[shell exited — press any key to reopen]',
    zh: '[shell 已退出 —— 按任意键重新打开]',
  },

  // ── 文件面板 ──
  'files.workspace': { en: 'Workspace files', zh: '工作区文件' },
  'files.unavailable': {
    en: 'List unavailable — the sandbox is asleep; send a message to wake it first',
    zh: '列表不可用 —— 沙箱休眠中，发条消息唤醒后再看',
  },
  'files.empty': { en: 'No files yet', zh: '还没有文件' },
  'files.edits': { en: 'Edit history', zh: '编辑记录' },
  'files.noEdits': { en: 'The agent has not touched any files yet', zh: 'Agent 还没有动过文件' },
  'files.download': { en: 'Click to download', zh: '点击下载' },
  'files.opView': { en: 'Read', zh: '读取' },
  'files.opCreate': { en: 'Create', zh: '新建' },
  'files.opEdit': { en: 'Edit', zh: '编辑' },
  'files.opRunning': { en: 'In progress…', zh: '进行中…' },

  // ── 积分 / 充值 ──
  'credits.credits': { en: 'credits', zh: '积分' },
  'credits.topUp': { en: 'Top up', zh: '充值' },
  'credits.balanceTitle': {
    en: 'Credit balance — every agent run spends credits',
    zh: '积分余额 —— Agent 每次运行都会消耗积分',
  },
  'credits.sessionUsed': { en: 'used', zh: '已消耗' },
  'credits.turnUsed': { en: 'This turn used', zh: '本 turn 消耗' },
  'credits.insufficientBrief': {
    en: 'Out of credits — top up to keep going',
    zh: '积分不足 —— 充值后继续使用',
  },
  'credits.budgetCapBrief': {
    en: 'Session budget cap reached — task stopped automatically',
    zh: '会话预算已达上限，任务已自动停止',
  },
  'recharge.title': { en: 'Top up credits', zh: '充值积分' },
  'recharge.sub': {
    en: 'Credits power every agent run — sandbox, model, everything. 1 credit = $0.01 of usage.',
    zh: '积分驱动 Agent 的每一次运行（沙箱、模型全包）。1 积分 = $0.01 用量。',
  },
  'recharge.bestValue': { en: 'Best value', zh: '最划算' },
  'recharge.buy': { en: 'Buy', zh: '购买' },
  'recharge.opening': { en: 'Opening checkout…', zh: '正在打开收银台…' },
  'recharge.unavailable': {
    en: 'Payments are not configured yet — please check back soon.',
    zh: '支付通道尚未配置，请稍后再试。',
  },
  'recharge.close': { en: 'Close', zh: '关闭' },
  'recharge.failed': {
    en: `Could not open checkout — please try again in a moment. If it persists, contact ${SUPPORT_EMAIL}.`,
    zh: `收银台打开失败 —— 请稍后再试。若持续失败，请联系 ${SUPPORT_EMAIL}。`,
  },
  'recharge.successToast': {
    en: 'Payment received — credits will land in a few seconds',
    zh: '支付成功 —— 积分将在几秒内到账',
  },

  // ── 报错（hook 外也能到的地方） ──
  'error.noSession': { en: 'No active session', zh: '没有会话' },
  'error.uploadFailed': { en: 'Upload failed', zh: '上传失败' },
  'error.network': { en: 'Network error', zh: '网络错误' },
  'error.loadSession': {
    en: 'Failed to load this session — click it again to retry',
    zh: '会话加载失败 —— 再点一次重试',
  },

  // ── 全站页脚 ──
  'footer.pricing': { en: 'Pricing', zh: '定价' },
  'footer.terms': { en: 'Terms of Service', zh: '服务条款' },
  'footer.privacy': { en: 'Privacy Policy', zh: '隐私政策' },
  'footer.support': { en: 'Support', zh: '联系支持' },

  // ── 主题切换 ──
  'theme.system': { en: 'Theme: system (click for light)', zh: '主题：跟随系统（点击切浅色）' },
  'theme.light': { en: 'Theme: light (click for dark)', zh: '主题：浅色（点击切深色）' },
  'theme.dark': { en: 'Theme: dark (click for system)', zh: '主题：深色（点击切跟随系统）' },
} as const

export type I18nKey = keyof typeof dict

interface I18nValue {
  lang: Lang
  /** toLocaleString 系用的区域串 */
  locale: string
  setLang(l: Lang): void
  t(key: I18nKey): string
}

const Ctx = createContext<I18nValue | null>(null)

export function I18nProvider({ children }: { children: ReactNode }) {
  // 初始恒为 'en'（SSR 与首渲染一致），挂载后再读 localStorage 修正
  const [lang, setLangState] = useState<Lang>('en')

  useEffect(() => {
    const saved = localStorage.getItem('cassia-lang')
    if (saved === 'zh' || saved === 'en') setLangState(saved)
  }, [])

  useEffect(() => {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'
  }, [lang])

  const setLang = useCallback((l: Lang) => {
    setLangState(l)
    localStorage.setItem('cassia-lang', l)
  }, [])

  const value = useMemo<I18nValue>(
    () => ({
      lang,
      locale: lang === 'zh' ? 'zh-CN' : 'en-US',
      setLang,
      t: (key) => dict[key][lang],
    }),
    [lang, setLang],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useI18n(): I18nValue {
  const v = useContext(Ctx)
  if (!v) throw new Error('useI18n 必须在 I18nProvider 内')
  return v
}

/** 语言切换。显示的是「切过去是什么」，不是「现在是什么」。 */
export function LangToggle() {
  const { lang, setLang } = useI18n()
  return (
    <button
      className="lang-toggle"
      onClick={() => setLang(lang === 'en' ? 'zh' : 'en')}
      title="Switch language / 切换语言"
    >
      {lang === 'en' ? '中文' : 'EN'}
    </button>
  )
}
