# socket-server 生产镜像。
# 为什么容器化：生产 VM 是 CentOS 7（glibc 2.17），官方 node >= 18 的
# 二进制要 glibc 2.28，宿主直接跑跑不了 —— 容器内是 Debian，问题消失。
# 构建上下文是仓库根（pnpm workspace，socket-server 依赖 @cassia/shared）。
FROM node:22-bookworm-slim
RUN corepack enable
WORKDIR /app

# 先只拷依赖清单，让 pnpm install 这层能被缓存
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY shared/package.json shared/
COPY socket-server/package.json socket-server/
RUN pnpm install --frozen-lockfile --filter @cassia/socket-server...

# 再拷源码（改动频繁，放后面）
COPY shared/src shared/src
COPY socket-server/src socket-server/src
COPY socket-server/tsconfig.json socket-server/

ENV SOCKET_PORT=4000
EXPOSE 4000
# SQLite 数据落卷：docker run -v cassia-data:/data，DB_PATH=/data/cassia.db
VOLUME /data
CMD ["pnpm", "-F", "@cassia/socket-server", "start"]
