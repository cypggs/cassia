/**
 * pi 扩展：把内置 bash 工具的执行后端换成本进程持有的常驻 PTY。
 *
 * 解决的问题（实测见 docs/03-pi-rpc.md §4）：pi 自带的 bash 每次都是全新
 * shell，`cd` / `export` / 激活的虚拟环境都不跨调用存活。模型在长任务里
 * 会反复踩这个坑 —— 装了第一个包装不上第二个，`cd` 进项目目录后
 * 下一条命令又在家门口跑。
 *
 * 做法不是新写一个工具，而是复用 `createBashTool` 只替换 `exec` ——
 * 参数 schema、输出截断、流式 partialResult 全部保留 pi 内置的实现，
 * 唯一改变的是命令落在哪个 shell 里跑。
 *
 * 输出协议：
 *   - spawn 后立刻 `stty -echo`：PTY 不回显输入，流里只有命令的真实输出
 *   - 完成标记由 PROMPT_COMMAND 产生（含退出码），PS1/PS2 置空 ——
 *     **不把标记写进 stdin**。曾经把 printf 标记行追加在命令后面一起写入，
 *     实测 sudo 会清空 tty 输入缓冲（安全设计），标记行直接被丢弃，
 *     命令永远等不到结束（线上事故）；任何读 stdin 的命令也有同样风险。
 *     PROMPT_COMMAND 由 bash 在命令结束后自己打印，不经过输入通道。
 *   - 命令本体走文件投递（`source <tmpfile>`），**永远单行** —— 直接把
 *     多行命令写进终端是另一个坑：heredoc 的正文已在输入缓冲时 bash 不等
 *     整体输完就提前执行、提前打提示符，一条工具调用产生多个完成标记，
 *     队列当场错位（实测遇到）。文件投递后：一条调用 = 一行 = 一个标记。
 *   - 标记带序号（脚本第一行设置 shell 变量，PROMPT_COMMAND 展开它），
 *     被 Ctrl-C 杀掉的命令迟到的标记序号对不上，不会污染下一条命令。
 *   - 标记可能被 PTY 分包截断，转发时只扣住末尾「像标记残段」的一小段，
 *     其余立刻发走 —— 流式体验不能死在缓冲上
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { createBashTool, type BashOperations } from '@earendil-works/pi-coding-agent'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as pty from 'node-pty'

/**
 * 兜底超时（秒）。pi 的 bash 工具不传 timeout 就是永不超时（查过源码，
 * resolveTimeoutMs(undefined) → undefined）—— 模型忘了给 timeout 时，
 * 一条丢标记/挂死的命令会挂到地老天荒（线上事故的帮凶）。
 * 只在模型没给 timeout 时生效；模型给了就尊重模型的。
 */
const BACKSTOP_TIMEOUT_S = Number(process.env.PI_SHELL_BACKSTOP_S ?? 1800)

/** 交互 bash 的提示符残留（bash-3.2$ 之类），独占一行。PS1 已置空，这层只是兜底 */
const PROMPT_LINE_RE = /^(?:bash-[\d.]+|[^\s@]+@[^\s:]+(?::[^\s]*)?)[\$#] ?.*$/gm
/** heredoc 等多行输入的续行提示符（"> " / "> > "）。PS2 已置空，这层只是兜底 */
const CONT_LINE_RE = /^>+ ?$/gm
/**
 * bracketed-paste 模式切换（bash ≥5 的 readline 每接收一行输入都会发）。
 * 必须先剥 —— 不然 `\x1b[?2004hbash-5.2$ ` 里的提示符因为不在行首，
 * 提示符正则够不着它。
 */
const BRACKETED_PASTE_RE = /\x1b\[\?2004[hl]/g

function stripPrompts(s: string): string {
  return s
    .replace(BRACKETED_PASTE_RE, '')
    .replace(PROMPT_LINE_RE, '')
    .replace(CONT_LINE_RE, '')
    .replace(/\n{3,}/g, '\n\n')
}

export class PersistentShell implements BashOperations {
  private term: pty.IPty | null = null
  /** stty -echo 与 PS1/PROMPT_COMMAND 生效的屏障 —— 第一条命令必须等它 */
  private ready: Promise<void> | null = null
  private buf = ''
  /**
   * 完成标记的随机 tag（`__PIDONE_<tag>_<序号>_<退出码>__`）。
   * 每个 shell 一个，也编进序号变量名 —— 模型看不见它，没法伪造或误触发。
   */
  private readonly tag = Math.random().toString(36).slice(2, 10)
  /** 命令序号：既是脚本文件名，也是完成标记的一部分（防迟到标记错位） */
  private seq = 0
  /** 是否有命令在跑。标记扫描只在它在时进行 */
  private active = false
  private onChunk: ((data: string) => void) | null = null
  private finish: ((code: number | null) => void) | null = null
  /** 命令输出是否已经开始 —— 开始前的 \r\n 只是 readline 的接收噪音，吞掉 */
  private contentStarted = true
  private queue: Promise<unknown> = Promise.resolve()
  /** 命令脚本的投递目录（见文件头「文件投递」） */
  private readonly scriptDir = join(tmpdir(), `pi-shell-${process.pid}`)

  constructor(private readonly cwd: string) {}

  private ensureTerm(): pty.IPty {
    if (this.term) return this.term
    const term = pty.spawn('/bin/bash', ['--norc', '-i'], {
      name: 'xterm-256color',
      cols: 220,
      rows: 50,
      cwd: this.cwd,
      env: process.env as Record<string, string>,
    })
    term.onData((d) => this.onPtyData(d))
    term.onExit(({ exitCode }) => {
      this.term = null
      this.ready = null
      // shell 死了（exit / 崩溃 / OOM）—— 若有命令在等，按被杀处理，
      // 下条命令会重建一个新 shell。持久性断了，但工具不会永久卡死。
      const f = this.finish
      this.active = false
      this.finish = null
      this.onChunk = null
      f?.(exitCode)
    })
    // 关掉回显，流里就只剩命令输出。
    // 要留一个生效窗口：第一条命令如果在初始化还没执行完时就到达，
    // 它的回显和启动横幅会混进工具结果（实测遇到）。
    // !active 期间的字节本来就会被丢弃，所以这段时间的噪音天然无害。
    term.write('stty -echo\n')
    // PS1/PS2 置空，提示符从此不存在，不用剥。
    // PROMPT_COMMAND 在每条命令执行完打印退出码标记 —— 它不经过 stdin，
    // sudo 清输入缓冲、命令读 stdin 之类都伤不到它。$? 必须最先捕获。
    // 标记里的序号展开自 shell 变量 __PI_SQ_<tag>：每个命令脚本的第一行
    // 会把它改成自己的序号，于是被 Ctrl-C 杀掉的命令迟到的标记序号
    // 对不上当前命令，扫描端直接丢弃，不会污染下一条（实测踩过：
    // 超时杀进程后，exit=130 的迟到标记把下一条命令提前 resolve 掉）。
    // 启动时变量还没设置，:-boot 兜一条永不被匹配的引导标记。
    term.write(
      `export PS1='' PS2='' PROMPT_COMMAND='__r=$?; printf "\\n__PIDONE_${this.tag}_\${__PI_SQ_${this.tag}:-boot}_%d__\\n" "$__r"'\n`,
    )
    this.ready = new Promise((r) => setTimeout(r, 250))
    this.term = term
    return term
  }

  private onPtyData(data: string): void {
    this.buf += data
    if (!this.active) {
      // 没有命令在跑：buf 里只可能是提示符/标记噪音（PROMPT_COMMAND 在
      // 启动时也会打一条），直接清空。留下的尾巴会在下条命令开始时
      // 被当成它的输出转发出去。
      this.buf = ''
      return
    }

    // 输出还没开始：readline 接收输入行时打的 \r\r\n 是噪音，吞掉
    if (!this.contentStarted) {
      const stripped = this.buf.replace(/^[\r\n]+/, '')
      if (!stripped) {
        this.buf = ''
        return
      }
      this.buf = stripped
      this.contentStarted = true
    }

    // 完成标记 = 命令结束 + 退出码。只认当前命令的序号 —— 序号对不上的
    // 是迟到标记（上一条被 Ctrl-C 杀掉后 PROMPT_COMMAND 补打的），不是
    // 当前命令的结束信号。抠掉它，标记前的内容就是全部输出。
    const re = new RegExp(`__PIDONE_${this.tag}_${this.seq}_(\\d+)__`)
    const m = re.exec(this.buf)
    if (m) {
      const before = this.buf.slice(0, m.index).replace(/[\r\n]+$/, '')
      this.buf = ''
      const code = Number(m[1])
      const f = this.finish
      this.active = false
      this.finish = null
      if (before) this.onChunk?.(stripPrompts(before))
      f?.(code)
      return
    }

    // 迟到/游离标记（别的序号，含 boot）：不是结束信号，但也不能漏进输出
    this.buf = this.buf.replace(
      new RegExp(`__PIDONE_${this.tag}_[A-Za-z0-9]+_\\d+__`, 'g'),
      '',
    )

    // 标记还没到：能发的都发走（流式！），只扣两种「残段」：
    //  1) 末尾可能是完成标记的一部分 —— `__PIDONE_…` 被 PTY 分包截断，
    //     发出去就把标记文本漏进输出了
    //  2) 末尾是半个 ANSI 转义 —— 剥除按段做，`\x1b[?2004l` 切开后
    //     两段各自都不匹配正则，拼起来就是一条裸序列（实测踩过）
    let cut = this.buf.length
    const markTail = /_+[A-Za-z0-9_]*$/.exec(this.buf)
    if (markTail) cut = Math.min(cut, markTail.index)
    const escTail = /\x1b(?:\[[0-9;?]*)?$/.exec(this.buf)
    if (escTail) cut = Math.min(cut, escTail.index)
    const emit = this.buf.slice(0, cut)
    this.buf = this.buf.slice(cut)
    if (emit) this.onChunk?.(stripPrompts(emit))
  }

  exec(
    command: string,
    _cwd: string,
    options: {
      onData: (data: Buffer) => void
      signal?: AbortSignal
      timeout?: number
      env?: NodeJS.ProcessEnv
    },
  ): Promise<{ exitCode: number | null }> {
    // 串行化：一个 shell 同一时刻只能跑一条命令。
    // pi 偶尔会并行发起两个 bash 调用，不排队的话输出会交织，
    // 而且标记没有按命令区分 —— 串行是标记协议成立的前提。
    const effectiveTimeout = options.timeout ?? BACKSTOP_TIMEOUT_S
    const run = this.queue.then(() => this.execOne(command, { ...options, timeout: effectiveTimeout }))
    this.queue = run.catch(() => {})
    return run
  }

  private async execOne(
    command: string,
    { onData, signal, timeout }: {
      onData: (data: Buffer) => void
      signal?: AbortSignal
      timeout?: number
    },
  ): Promise<{ exitCode: number | null }> {
    const term = this.ensureTerm()
    // 等初始化（stty + PS1/PROMPT_COMMAND）生效，第一条命令的回显才不会混进输出
    if (this.ready) await this.ready

    // 命令写进临时脚本，终端里只发一行 source —— 多行命令直接写进终端的话，
    // heredoc 提前执行会产生多个完成标记（见文件头）。
    // 脚本第一行把序号变量拨到自己的序号：命令结束（或被 Ctrl-C 打断）时
    // PROMPT_COMMAND 展开的序号就是这条命令的，各命令的标记不会错位。
    mkdirSync(this.scriptDir, { recursive: true })
    const seq = ++this.seq
    const script = join(this.scriptDir, `cmd-${seq}.sh`)

    return new Promise((resolve, reject) => {
      let settled = false
      const settle = (fn: () => void) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        this.onChunk = null
        this.finish = null
        this.active = false
        rmSync(script, { force: true })
        fn()
      }

      const timer = timeout
        ? setTimeout(() => {
            term.write('\x03') // Ctrl-C
            settle(() => reject(new Error(`timeout:${timeout}`)))
          }, timeout * 1000)
        : undefined

      const onAbort = () => {
        term.write('\x03')
        settle(() => reject(new Error('aborted')))
      }
      signal?.addEventListener('abort', onAbort, { once: true })

      // 清掉上一条命令遗留的噪音，让输出从干净状态开始
      this.buf = ''
      this.contentStarted = false
      this.active = true
      this.onChunk = (data) => onData(Buffer.from(data))
      this.finish = (code) => settle(() => resolve({ exitCode: code }))

      // 只写一行 source。结束检测完全交给 PROMPT_COMMAND —— 见文件头。
      writeFileSync(script, `__PI_SQ_${this.tag}=${seq}\n${command}`, { mode: 0o600 })
      term.write(`source '${script}'\n`)
    })
  }
}

export default function (pi: ExtensionAPI): void {
  const cwd = process.cwd()
  const shell = new PersistentShell(cwd)
  pi.registerTool(createBashTool(cwd, { operations: shell }))
}
