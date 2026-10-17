import { EventEmitter } from 'node:events'
import WebSocket from 'ws'
import type { AgentEvent } from '@cassia/shared'

/**
 * 控制面 ↔ 沙箱内 agent-runtime 的连接。
 *
 * 方向是**控制面主动拨出去**，不是 runtime 连回来。理由很实际：
 * E2B 的端口转发让沙箱有公网地址，而本地开发时控制面没有 —— 拨出去两边都成立。
 *
 * 断线自动重连。沙箱冷启动要几秒，第一次连必然失败，所以重连不是异常路径，
 * 是正常路径。
 */
export interface BridgeOptions {
  model?: string
  /**
   * 下发给沙箱内 pi 的环境变量（provider key）。
   *
   * 密钥不烤进镜像，也不靠 E2B 创建时的 `envs` —— 那条路依赖 start_cmd
   * 与环境注入的先后顺序，不保证。走 attach 就没有这个时序窗口，
   * 而且同一个镜像可以服务不同 provider 的会话。
   */
  env?: Record<string, string>
}

export class RuntimeBridge extends EventEmitter {
  private ws?: WebSocket
  private closed = false
  private retry = 0
  private timer?: NodeJS.Timeout
  private heartbeat?: NodeJS.Timeout
  /** 发出 ping 后在等 pong —— 下个心跳周期还没等到就是半开僵尸连接 */
  private waitingPong = false

  constructor(
    private url: string,
    private sessionId: string,
    private opts: BridgeOptions = {},
  ) {
    super()
  }

  connect(): void {
    if (this.closed) return
    const ws = new WebSocket(this.url)
    this.ws = ws

    ws.on('open', () => {
      this.retry = 0
      this.waitingPong = false
      // 先认领会话，runtime 才知道把这条连接的指令和事件归到哪个 pi 进程。
      // 本机开发时多个会话共用一个 runtime，不认领就会串台。
      ws.send(JSON.stringify({
        type: 'attach',
        sessionId: this.sessionId,
        model: this.opts.model,
        env: this.opts.env,
      }))
      this.startHeartbeat()
      this.emit('open')
    })

    ws.on('message', (raw) => {
      // 任何下行数据都证明连接是活的
      this.waitingPong = false
      let msg: { type?: string; event?: AgentEvent; data?: string; code?: number }
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (msg.type === 'event' && msg.event) this.emit('event', msg.event)
      // console 帧是用户独立 shell 的原始字节/退出码，转发给 Socket.IO 层
      else if (msg.type === 'console' && typeof msg.data === 'string') this.emit('console', msg.data)
      else if (msg.type === 'console_exit') this.emit('console_exit', msg.code ?? 0)
    })
    ws.on('pong', () => {
      this.waitingPong = false
    })

    ws.on('error', (e) => this.emit('warn', e.message))
    ws.on('close', () => {
      this.stopHeartbeat()
      if (this.closed) return
      // 连不上了（沙箱被外部暂停/回收的 502 循环）——重连没有指望，
      // 上报给控制面走「标记休眠 → 下条消息唤醒」的路，不要在这里空转到永远
      // （线上踩过：沙箱被 E2B 超时暂停后这里 502 循环几小时，会话假活）。
      if (++this.retry > MAX_RETRY) {
        this.emit('unreachable')
        return
      }
      // 1s → 2s → 4s … 封顶 10s
      const delay = Math.min(1000 * 2 ** (this.retry - 1), 10_000)
      this.emit('warn', `runtime 连接断开，${delay}ms 后重试`)
      this.timer = setTimeout(() => this.connect(), delay)
    })
  }

  /**
   * 心跳探活。TCP 半开连接（对端消失但没有 RST —— 沙箱 pause/resume 后的
   * 典型状态）不会触发 close，write 进去的字节进黑洞，不重连永远好不了。
   * ping/pong 是 ws 自带的探活：一个周期没 pong 就 terminate，
   * close 事件会带我们走进上面的重连逻辑。
   */
  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeat = setInterval(() => {
      if (this.closed || this.ws?.readyState !== WebSocket.OPEN) return
      if (this.waitingPong) {
        this.ws?.terminate()
        return
      }
      this.waitingPong = true
      this.ws.ping()
    }, HEARTBEAT_MS)
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = undefined
    this.waitingPong = false
  }

  private send(o: Record<string, unknown>): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false
    this.ws.send(JSON.stringify(o))
    return true
  }

  prompt(text: string): boolean {
    return this.send({ type: 'prompt', text })
  }

  steer(text: string): boolean {
    return this.send({ type: 'steer', text })
  }

  abort(): boolean {
    return this.send({ type: 'abort' })
  }

  consoleStart(cols: number, rows: number): boolean {
    return this.send({ type: 'console_start', cols, rows })
  }

  consoleInput(data: string): boolean {
    return this.send({ type: 'console_input', data })
  }

  consoleResize(cols: number, rows: number): boolean {
    return this.send({ type: 'console_resize', cols, rows })
  }

  consoleClose(): boolean {
    return this.send({ type: 'console_close' })
  }

  close(): void {
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.stopHeartbeat()
    this.ws?.close()
  }
}

/** 心跳周期。两个周期（30s）没 pong 就判半开，terminate 重连 */
const HEARTBEAT_MS = 15_000
/**
 * 连续重连失败的上限（~25 秒：1+2+4+8+10）。
 * 冷启动由 waitHealthy 兜底过第一道，bridge 建起来之后的 502 只有一种
 * 解释：沙箱没了。判错了也不要紧 —— 标记休眠后下条消息走 resume
 * （connect 自动唤醒），代价只是一次无害的暂停/恢复。
 */
const MAX_RETRY = 6
