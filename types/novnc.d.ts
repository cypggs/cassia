/**
 * noVNC 1.7 不带 TypeScript 类型。这里只声明我们实际用到的那部分，
 * 不去复刻整个 API —— 声明得越多，将来升级时假类型和真实现对不上的面越大。
 */
declare module '@novnc/novnc' {
  interface RFBOptions {
    credentials?: { username?: string; password?: string; target?: string }
    shared?: boolean
    wsProtocols?: string[]
  }

  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string, options?: RFBOptions)
    /** 缩放画面以适应容器，而不是裁切 */
    scaleViewport: boolean
    /** 是否让远端桌面跟着容器改分辨率。沙箱是固定分辨率，保持 false */
    resizeSession: boolean
    /** true = 只看不操作 */
    viewOnly: boolean
    background: string
    disconnect(): void
    focus(): void
  }
}
