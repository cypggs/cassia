/**
 * agent-runtime 的供给。两种模式，同一个接口：
 *
 * - **local**：设了 `AGENT_RUNTIME_URL` 就直接用它。开发时把 runtime 跑在本机，
 *   省掉沙箱冷启动，改一行代码立刻见效。
 * - **e2b**：起一个 E2B 沙箱，runtime 由模板的 start_cmd 自启。
 *
 * runtime 对「自己在哪」无感知，所以这两条路跑的是同一份代码。
 *
 * **不做运行时 bootstrap。** 早先试过「起 base 模板 → 推源码进去 → 现装 pi」，
 * 这条路是死的：pi 要求 node >= 22.19，而 E2B 的 base 只有 20.9。
 * 就算 node 够，现装依赖也要 60~120 秒，用户在前面干等。
 * 现在 pi 和编译好的 runtime 都烤在模板里（sandbox-lite/e2b.Dockerfile），
 * 冷启动 ~3 秒。
 *
 * **镜像里没有密钥。** provider 的 key 不走 `Sandbox.create` 的 envs ——
 * 那依赖环境注入与 start_cmd 的先后顺序，没有保证。key 由控制面在
 * WebSocket attach 时下发（见 bridge.ts），到 pi spawn 的那一刻才落地。
 *
 * **空闲策略是「暂停」不是「销毁」。** 沙箱创建时带
 * `lifecycle: { onTimeout: 'pause' }`：timeout 到了 E2B 会对它做全内存快照
 * 然后挂起 —— 不计费，但文件系统、进程、浏览器标签页全保留。
 * 会话再次活跃时 `resume()` 用 `Sandbox.connect()` 恢复，pi 进程原地醒来，
 * 连对话上下文都在。用户看到的是「这台电脑还是昨天那台」。
 */

export interface RuntimeHandle {
  sandboxId: string
  /** agent-runtime 的 WebSocket 地址 */
  wsUrl: string
  /** 浏览器直连沙箱看画面，控制面不中转 */
  vncUrl?: string
  webRTCUrl?: string
  /**
   * 续期硬超时。
   *
   * E2B 的 timeoutMs 从**创建那一刻**起倒计时，不随活跃刷新 —— 不续的话，
   * 一个一直在跑的长任务到点也会被拦腰斩断。每次活跃都重置成「从现在起
   * 再过一个 timeoutMs」。内部有防抖，调用方不需要考虑频率。
   */
  touch(): void
  /**
   * 恢复一个被暂停的沙箱（本机模式是 no-op）。
   *
   * 可能抛出：E2B 的快照有保留期，睡太久的沙箱会被彻底清掉，
   * 那时候恢复失败，调用方要退回到「重新 provision 一台」。
   */
  resume(): Promise<void>
  kill(): Promise<void>
  /**
   * 附件通道：会话工作目录内的相对路径读写（runtime 里 pi 的 cwd 就是这个目录，
   * 所以 prompt 里告诉 Agent 相对路径它就能直接用工具读）。
   *
   * e2b 走 SDK 的 files API（二进制流式，不进 ws/base64）；
   * local 模式直接读写本机 WORKSPACE 目录 —— 两种模式同一份调用方代码。
   */
  writeFile(rel: string, data: Buffer | ReadableStream<Uint8Array>): Promise<void>
  readFile(rel: string): Promise<ReadableStream<Uint8Array>>
  listFiles(): Promise<{ path: string; size: number; mtime: number }[]>
}

const RUNTIME_PORT = 8330
const VNC_PORT = 5901
const NEKO_PORT = 8333

/** 模板里烤死的 WORKSPACE（sandbox-desktop/lite 的 ENV），会话目录是它的子目录 */
const E2B_WORKSPACE = '/home/user/workspace'

/** 带画面通道的模板。lite 只有 runtime，没有 Xorg / x11vnc / neko。
 * agentbox 是沿用原项目的完整桌面模板（Xorg + x11vnc + neko）。 */
const SCREEN_TEMPLATES = new Set(['cassia', 'agentbox'])

export async function provision(opts: { model: string; sessionId: string }): Promise<RuntimeHandle> {
  const local = process.env.AGENT_RUNTIME_URL
  if (local) {
    // 本机模式：runtime 和 socket-server 同台机器，文件直接落 WORKSPACE 目录
    const root = process.env.WORKSPACE
    return {
      sandboxId: 'local',
      wsUrl: local.replace(/\/$/, '') + '/ws',
      touch() {},
      async resume() {},
      async kill() {},
      async writeFile(rel, data) {
        const fs = await import('node:fs/promises')
        const p = localPath(root, opts.sessionId, rel)
        await fs.mkdir(p.slice(0, p.lastIndexOf('/')), { recursive: true })
        if (Buffer.isBuffer(data)) await fs.writeFile(p, data)
        else await fs.writeFile(p, await collect(data))
      },
      async readFile(rel) {
        const fs = await import('node:fs/promises')
        return bufferStream(await fs.readFile(localPath(root, opts.sessionId, rel)))
      },
      async listFiles() {
        const fs = await import('node:fs/promises')
        const base = localPath(root, opts.sessionId, '.')
        const out: { path: string; size: number; mtime: number }[] = []
        const walk = async (dir: string, prefix: string, depth: number): Promise<void> => {
          if (depth > 4) return
          for (const ent of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
            if (ent.name.startsWith('.')) continue
            const rel = prefix ? `${prefix}/${ent.name}` : ent.name
            if (ent.isDirectory()) await walk(`${dir}/${ent.name}`, rel, depth + 1)
            else {
              const st = await fs.stat(`${dir}/${ent.name}`)
              out.push({ path: rel, size: st.size, mtime: st.mtimeMs })
            }
          }
        }
        await walk(base, '', 0)
        return out.sort((a, b) => b.mtime - a.mtime)
      },
    }
  }
  return provisionE2B(opts)
}

/** 本机模式拼路径：WORKSPACE 未设时无法定位 runtime 的会话目录，明说原因 */
function localPath(root: string | undefined, sessionId: string, rel: string): string {
  if (!root) throw new Error('本机模式传文件需要 WORKSPACE 环境变量（和 runtime 同一个）')
  return `${root}/${sessionId}/${rel}`
}

async function collect(s: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = []
  const reader = s.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

function bufferStream(buf: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(c) { c.enqueue(buf); c.close() } })
}

/** e2b files.write 吃 ArrayBuffer 不吃 Buffer —— Buffer 转底层 ArrayBuffer 再传 */
function toUploadPayload(
  data: Buffer | ReadableStream<Uint8Array>,
): ArrayBuffer | ReadableStream<Uint8Array> {
  if (!Buffer.isBuffer(data)) return data
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
}

async function provisionE2B(opts: { model: string; sessionId: string }): Promise<RuntimeHandle> {
  const { Sandbox } = await import('e2b')

  const template = process.env.E2B_TEMPLATE ?? 'cassia-lite'
  const timeoutMs = Number(process.env.E2B_TIMEOUT_MS ?? 30 * 60 * 1000)
  const sessionRoot = `${E2B_WORKSPACE}/${opts.sessionId}`

  // 用 let 不用 const —— resume() 走 Sandbox.connect() 会换回一个新实例
  //
  // create 本身要有时限：E2B 控制面抖动时这个 promise 可能永远不落，
  // 前端就永远停在「正在准备计算环境…」（线上踩过）。超时要杀得掉就杀，
  // 杀不掉也由它去 —— 它有自己的 timeoutMs 兜底回收。
  let sbx = await withTimeout(
    Sandbox.create(template, {
      timeoutMs,
      // 只放非敏感的运行参数。密钥走 attach，理由见文件头。
      // PI_PROVIDER 必须显式透进去：pi 0.87 不会从 deepseek/xxx 的 model
      // 字符串反推 provider（会错去 openrouter 找 key），见 README。
      envs: {
        PI_MODEL: opts.model,
        ...(process.env.PI_PROVIDER ? { PI_PROVIDER: process.env.PI_PROVIDER } : {}),
      },
      // 归属标记：存储对账脚本（scripts/sandbox-storage-report.mjs）靠它
      // 认 sandbox → session 的映射，孤儿/超龄才敢直接 kill
      metadata: { app: 'cassia', sessionId: opts.sessionId },
      lifecycle: {
        // 到点不杀，做全内存快照挂起。keepMemory 默认 true —— 要的就是
        // 进程原地醒来；纯文件系统快照会把 runtime 和 pi 都冷启掉，没意义。
        onTimeout: { action: 'pause' },
        // autoResume 故意不开：浏览器端 noVNC 的重连循环也算「入向流量」，
        // 开了它，一个没关的「画面」tab 会把休眠的沙箱反复唤醒，白烧额度。
        // 恢复只走控制面的显式 resume()。
        autoResume: false,
      },
    }),
    120_000,
    `沙箱创建超过 120 秒未返回（模板 ${template}）`,
  )

  const host = sbx.getHost(RUNTIME_PORT)
  await waitHealthy(`https://${host}/healthz`, sbx)

  const handle: RuntimeHandle = {
    sandboxId: sbx.sandboxId,
    wsUrl: `wss://${host}/ws`,
    touch: makeTouch(() => sbx, timeoutMs),
    async resume() {
      // connect() 遇到 paused 的沙箱会自动恢复快照；timeoutMs 重新计
      sbx = await Sandbox.connect(sbx.sandboxId, { timeoutMs })
      await waitHealthy(`https://${sbx.getHost(RUNTIME_PORT)}/healthz`, sbx)
    },
    async kill() {
      await sbx.kill()
    },
    async writeFile(rel, data) {
      // 闭包取 sbx 不捕获 —— resume 后旧实例已死（makeTouch 同款理由）
      await sbx.files.write(`${sessionRoot}/${rel}`, toUploadPayload(data))
    },
    async readFile(rel) {
      return sbx.files.read(`${sessionRoot}/${rel}`, { format: 'stream' })
    },
    async listFiles() {
      const entries = await sbx.files.list(sessionRoot, { depth: 4 })
      return entries
        .filter((e) => e.type === 'file')
        .map((e) => ({
          path: e.path.slice(sessionRoot.length + 1),
          size: e.size,
          mtime: e.modifiedTime?.getTime() ?? 0,
        }))
        .sort((a, b) => b.mtime - a.mtime)
    },
  }

  if (SCREEN_TEMPLATES.has(template)) {
    handle.vncUrl = `wss://${sbx.getHost(VNC_PORT)}/websockify`
    handle.webRTCUrl = `wss://${sbx.getHost(NEKO_PORT)}/api/ws`
  }
  return handle
}

/**
 * 生成防抖的续期函数。
 *
 * Agent 事件一秒能来好几条，每条都打一次 E2B API 既没必要也会撞限流。
 * 一分钟最多续一次 —— 相对 30 分钟的窗口，这个粒度绰绰有余。
 * 续期失败（比如沙箱刚好被暂停）只告警，不往上传 —— 那不是调用方能处理的事。
 *
 * getSbx 是函数而不是实例：resume() 会换掉底层的 Sandbox 对象，
 * 闭包捕获旧实例的话，续的就是一台已经不在了的机器。
 */
function makeTouch(
  getSbx: () => { sandboxId: string; setTimeout(timeoutMs: number): Promise<unknown> },
  timeoutMs: number,
): () => void {
  const MIN_INTERVAL = 60_000
  let last = 0
  let inflight = false
  return () => {
    const now = Date.now()
    if (inflight || now - last < MIN_INTERVAL) return
    last = now
    inflight = true
    getSbx()
      .setTimeout(timeoutMs)
      .catch((e) => {
        const msg = e instanceof Error ? e.message : String(e)
        // 暂停中的沙箱续期会报 not found —— 倒计时本来就停了，不需要续。
        // 真被彻底回收的情形由 resume() 的失败兜底（退回新建），这里不告警。
        if (/not found/i.test(msg)) return
        console.warn(`[${getSbx().sandboxId}] 续期失败:`, msg)
      })
      .finally(() => {
        inflight = false
      })
  }
}

/**
 * 接回一个已存在的沙箱（服务重启后 live 表是空的，但 DB 记着每个会话的沙箱）。
 *
 * Sandbox.connect 遇到 paused 会自动恢复快照，所以这条路同时覆盖
 * 「重启前还活着」和「重启前已休眠」两种。接不上（快照过期被回收）抛出，
 * 调用方退回新建。
 *
 * 故意不带 vncUrl/webRTCUrl：地址是按 sandboxId 推导的确定性 URL，
 * 前端回放持久化的 sandboxUpdate 时已经拿到过同一个地址，
 * 这里再发一遍没有新信息，反而要猜模板有没有画面通道。
 */
export async function reconnect(sandboxId: string, sessionId: string): Promise<RuntimeHandle> {
  const { Sandbox } = await import('e2b')
  const timeoutMs = Number(process.env.E2B_TIMEOUT_MS ?? 30 * 60 * 1000)
  const sessionRoot = `${E2B_WORKSPACE}/${sessionId}`

  // connect 的 404 有两副面孔：沙箱真没了，或者创建/暂停状态在 E2B 控制面
  // 还没传播完（实测：刚建 15s 的沙箱 connect 偶发 404，稍后自愈）。
  // 真没了的代价只是多等 20s 退回新建；传播 lag 不重试就是误杀一台好机器。
  let sbx: Awaited<ReturnType<typeof Sandbox.connect>> | undefined
  let lastErr: unknown
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      sbx = await withTimeout(
        Sandbox.connect(sandboxId, { timeoutMs }),
        90_000,
        `接回沙箱 ${sandboxId} 超过 90 秒`,
      )
      break
    } catch (e) {
      lastErr = e
      if (attempt < 3) await new Promise((r) => setTimeout(r, 5_000))
    }
  }
  if (!sbx) throw lastErr
  // 下面闭包里的 sbx!：循环后已判空，resume 里的重新赋值也是同类型
  await waitHealthy(`https://${sbx.getHost(RUNTIME_PORT)}/healthz`, sbx)

  return {
    sandboxId: sbx.sandboxId,
    wsUrl: `wss://${sbx.getHost(RUNTIME_PORT)}/ws`,
    touch: makeTouch(() => sbx!, timeoutMs),
    async resume() {
      sbx = await Sandbox.connect(sbx!.sandboxId, { timeoutMs })
      await waitHealthy(`https://${sbx.getHost(RUNTIME_PORT)}/healthz`, sbx)
    },
    async kill() {
      await sbx!.kill()
    },
    async writeFile(rel, data) {
      await sbx!.files.write(`${sessionRoot}/${rel}`, toUploadPayload(data))
    },
    async readFile(rel) {
      return sbx!.files.read(`${sessionRoot}/${rel}`, { format: 'stream' })
    },
    async listFiles() {
      const entries = await sbx!.files.list(sessionRoot, { depth: 4 })
      return entries
        .filter((e) => e.type === 'file')
        .map((e) => ({
          path: e.path.slice(sessionRoot.length + 1),
          size: e.size,
          mtime: e.modifiedTime?.getTime() ?? 0,
        }))
        .sort((a, b) => b.mtime - a.mtime)
    },
  }
}

/** promise 加硬时限。到点 reject，原 promise 由它自己的生命周期兜底。 */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(what)), ms)
    p.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}

/**
 * 等 runtime 就绪。
 *
 * 模板的 --ready-cmd 已经在构建期验证过一次，但每个新沙箱仍要重新拉起
 * start_cmd —— 而且端口转发本身也有几百毫秒的建立时间。宁可在这里多等，
 * 也不要让 bridge 拿着一个还没监听的地址去重连。
 */async function waitHealthy(
  url: string,
  sbx: { sandboxId: string; kill(): Promise<unknown> },
  tries = 45,
): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(4000) })
      if (r.ok) return
    } catch {
      /* 冷启动期间连不上是正常路径，不是异常 */
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  // 起不来的沙箱要销毁，否则会一直挂到 timeoutMs 才回收，白烧额度
  await sbx.kill().catch(() => {})
  throw new Error(`agent-runtime 在沙箱 ${sbx.sandboxId} 内 ${tries} 秒未就绪`)
}
