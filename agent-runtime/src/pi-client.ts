import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'

/**
 * pi `--mode rpc` 的 JSON 行协议封装。
 *
 * 命令走 stdin（每行一个 JSON 对象，字段名是 `type` 不是 `command`），
 * 事件走 stdout。stderr 只有告警噪音，不参与协议。
 */

export interface PiClientOptions {
  cwd: string
  model?: string
  provider?: string
  thinking?: string
  /**
   * pi 1.1+ 的 --tools 增量调整项(如 ['+codemode'] 叠加 codemode,
   * ['-write'] 关掉 write)。空 = pi 默认工具集。
   */
  toolsAdjust?: string[]
  systemPromptAppend?: string
  bin?: string
  /**
   * 额外注入给 pi 子进程的环境变量（provider 的 API key 走这里）。
   *
   * 刻意不从镜像或 E2B 的 `envs` 拿 —— 镜像里不该有密钥，而 E2B 的 envs
   * 是否在 start_cmd 之前就绪也不保证。控制面在 attach 时下发，
   * 到这里才落到子进程，时序上没有空窗。
   */
  env?: Record<string, string>
  /**
   * 显式加载的 pi 扩展路径（`-e`）。和 `--no-extensions` 不冲突 ——
   * 后者只是不自动发现，显式给的照加载。
   * 接受文件路径或 `builtin:<name>`：MCP 是内置扩展，`-ne` 会连它
   * 一起禁掉，配了 MCP 的会话要显式给 `builtin:mcp` 加回来。
   */
  extensions?: string[]
}

/** pi 输出事件（实测采集，见 docs/03-pi-rpc.md） */
export interface PiEvent {
  type: string
  [k: string]: unknown
}

export class PiClient extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams
  private buf = ''
  private ready = false
  /** command → 等待中的 response。pi 的 response 带 command 字段，按它配对 */
  private pending = new Map<string, { resolve: (e: PiEvent) => void; timer: NodeJS.Timeout }>()

  constructor(private opts: PiClientOptions) {
    super()
  }

  start(): void {
    const args = ['--mode', 'rpc', '--no-extensions', '--no-skills']
    for (const ext of this.opts.extensions ?? []) args.push('-e', ext)
    if (this.opts.toolsAdjust?.length) args.push('--tools', this.opts.toolsAdjust.join(','))
    if (this.opts.model) args.push('--model', this.opts.model)
    if (this.opts.provider) args.push('--provider', this.opts.provider)
    if (this.opts.thinking) args.push('--thinking', this.opts.thinking)
    if (this.opts.systemPromptAppend) {
      args.push('--append-system-prompt', this.opts.systemPromptAppend)
    }

    const env = { ...process.env, ...this.opts.env }

    this.child = spawn(this.opts.bin ?? 'pi', args, {
      cwd: this.opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    })

    this.child.stdout.on('data', (d: Buffer) => this.onStdout(d))
    this.child.stderr.on('data', (d: Buffer) => {
      const s = d.toString()
      // pi 会为未识别的 thinking level 之类打告警，不是错误
      if (!s.includes('Warning:')) this.emit('stderr', s)
    })
    this.child.on('exit', (code) => {
      this.ready = false
      // 进程没了，等 response 的请求全部落空 —— 立刻拒掉，别等各自的超时
      for (const [cmd, p] of this.pending) {
        clearTimeout(p.timer)
        p.resolve({ type: 'response', command: cmd, success: false, error: `pi exited (${code})` })
      }
      this.pending.clear()
      this.emit('exit', code)
    })
    this.child.on('error', (err) => this.emit('error', err))
  }

  private onStdout(chunk: Buffer): void {
    this.buf += chunk.toString()
    let i: number
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i)
      this.buf = this.buf.slice(i + 1)
      if (!line.trim()) continue
      let ev: PiEvent
      try {
        ev = JSON.parse(line) as PiEvent
      } catch {
        this.emit('stderr', `[unparseable] ${line.slice(0, 200)}`)
        continue
      }
      // 第一个 response 意味着 RPC 循环已就绪
      if (!this.ready && ev.type === 'response') {
        this.ready = true
        this.emit('ready')
      }
      // request/response 配对：response 带 command 字段
      if (ev.type === 'response' && typeof ev.command === 'string') {
        const p = this.pending.get(ev.command)
        if (p) {
          this.pending.delete(ev.command)
          clearTimeout(p.timer)
          p.resolve(ev)
        }
      }
      this.emit('event', ev)
    }
  }

  private send(o: Record<string, unknown>): void {
    if (!this.child) throw new Error('pi not started')
    this.child.stdin.write(JSON.stringify(o) + '\n')
  }

  prompt(message: string): void {
    this.send({ type: 'prompt', message })
  }

  /** 任务执行中途插话干预 —— pi 原生就有，自己写循环要重新踩一遍 */
  steer(message: string): void {
    this.send({ type: 'steer', message })
  }

  abort(): void {
    this.send({ type: 'abort' })
  }

  /**
   * 宿主直接执行 bash（不经模型）。
   * 注意它走的是 `bash_execution_update`，delta 是**真增量**；
   * 而模型自己调 bash 工具走 `tool_execution_update`，是**累积快照**。
   */
  bash(command: string): void {
    this.send({ type: 'bash', command })
  }

  /**
   * 发一条有 response 的命令并等它。看门狗探活（get_state）和
   * 崩溃自愈（switch_session）都走这条。超时 reject —— 健康但忙碌的 pi
   * 也会逐行处理 RPC，15s 不答就是死了/卡死了。
   */
  request(command: string, payload: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<PiEvent> {
    if (this.pending.has(command)) {
      return Promise.reject(new Error(`request ${command} 已在等待中`))
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(command)
        reject(new Error(`request ${command} ${timeoutMs}ms 无响应`))
      }, timeoutMs)
      this.pending.set(command, { resolve, timer })
      try {
        this.send({ type: command, ...payload })
      } catch (e) {
        clearTimeout(timer)
        this.pending.delete(command)
        reject(e)
      }
    })
  }

  /** 看门狗探活。resolve 即活，reject/超时即死。 */
  async ping(timeoutMs = 15_000): Promise<boolean> {
    try {
      await this.request('get_state', {}, timeoutMs)
      return true
    } catch {
      return false
    }
  }

  /** 崩溃自愈：接回落盘的旧会话（活证据：scripts/e2e-chaos.mjs 场景 B） */
  switchSession(sessionPath: string): Promise<PiEvent> {
    return this.request('switch_session', { sessionPath }, 30_000)
  }

  /** 先礼后兵：SIGTERM 给 5s 体面退出的机会，再 SIGKILL */
  stop(): void {
    const c = this.child
    if (!c || c.killed) return
    c.kill('SIGTERM')
    setTimeout(() => {
      if (c.exitCode === null && !c.killed) c.kill('SIGKILL')
    }, 5_000).unref()
  }
}
