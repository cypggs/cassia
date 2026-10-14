import type { NextConfig } from 'next'

const config: NextConfig = {
  // shared 以 TS 源码形式被引用（没有构建步骤），交给 Next 一起编译
  transpilePackages: ['@cassia/shared'],
  // 上层目录还有别的 lockfile，不锁定的话 Turbopack 会把工作区根推断到 ~/
  turbopack: { root: import.meta.dirname },
}

export default config
