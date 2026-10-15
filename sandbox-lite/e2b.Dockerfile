# cassia-lite —— 只跑 agent-runtime + pi 的精简沙箱镜像。
#
# 相对完整的 sandbox/e2b.Dockerfile（带 Xorg / Chromium / neko / x11vnc），
# 这个只有 Node + pi + runtime，构建快得多。它存在的理由是把
# 「E2B 传输链路」和「浏览器画面」两件事解耦：终端流、端口转发、
# 会话隔离、生命周期，全都可以在这个镜像上先验证完，
# 完整镜像只需再验证画面那一段。
#
# 构建（context 是仓库根目录，因为要 COPY shared/ 和 agent-runtime/）：
#   cd ~/cassia && ./sandbox-lite/build.sh
#
# **单阶段。** E2B 的 CLI 自己解析 Dockerfile 而不是调 docker build，
# 多阶段构建会直接报 "Multi-stage Dockerfiles are not supported"。
# 所以编译工具链和产物在同一层里，编译完当场删掉。
#
# 镜像里**没有任何密钥**。provider 的 API key 由控制面在 WebSocket
# attach 时下发，落到 pi 子进程的 env 里。见 agent-runtime/src/index.ts。

FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8

# Agent 干活要用的基本工具。刻意保持克制 —— 每多一个包，
# 镜像大一分、冷启动慢一分，缺什么让 Agent 自己 apt-get 得上。
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl wget git jq unzip zip less procps \
      python3 python3-pip python3-venv \
      ripgrep tree file \
 && rm -rf /var/lib/apt/lists/*

# pi 要求 node >= 22.19.0。E2B 的 base 模板只有 20.9 —— 这个模板
# 存在的直接原因就是那道下限。构建期断言一次，
# 免得将来换基础镜像时静默退化成一个跑不起来的沙箱。
RUN node -e "const [a,b]=process.versions.node.split('.').map(Number); if (a<22 || (a===22 && b<19)) { console.error('node '+process.versions.node+' < 22.19.0 (pi 的下限)'); process.exit(1) } console.log('node '+process.versions.node+' OK')"

WORKDIR /opt/cassia

# 先装运行时依赖 —— 这层最慢（pi 有 164MB），放前面让改代码不失效缓存
RUN npm init -y > /dev/null \
 && npm pkg set type=module \
 && npm install ws@8.21.1 \
 && npm install typebox@1.1.38 \
 && npm install -g @earendil-works/pi-coding-agent@1.2.0 \
 && npm cache clean --force \
 && pi --version

# node-pty —— 持久 shell 扩展（pi-extension/persistent-shell.ts）的原生模块。
# npm 包只带 darwin/win32 的预编译产物，Linux 上必须现场 node-gyp 编译，
# 所以 build-essential 装在同一层、编完当场卸掉，工具链不进最终镜像。
RUN apt-get update && apt-get install -y --no-install-recommends build-essential \
 && npm install node-pty@1.1.0 \
 && node -e "const p=require('node-pty'); if(typeof p.spawn!=='function')process.exit(1); console.log('node-pty OK')" \
 && apt-get purge -y build-essential && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

# 扩展对 pi 包的 import（createBashTool 等）由 pi 自己的扩展加载器解析 ——
# 本机探针里 agent-runtime/node_modules 并没有 pi 包，加载照样成功。
# **不要**把全局的 pi 软链进本地 node_modules：arborist 会跟随软链
# 「修剪」目标目录，任何后续 npm install 都会把全局 pi 清空（实测踩过）。

COPY shared/src ./build/shared/src
COPY agent-runtime/src ./build/agent-runtime/src
COPY sandbox-lite/tsconfig.build.json ./build/tsconfig.json
# 扩展不编译 —— pi 自己的加载器直接吃 TS（本机探针验证过），
# 而且它依赖 pi 包提供的 createBashTool，编译时解析不到。
COPY agent-runtime/pi-extension ./pi-extension

# 构建期编译成 JS，运行时用纯 node 起。
# 不用 tsx 边跑边转译：启动慢、常驻内存高，而且语法错误要等到
# 沙箱跑起来才暴露 —— 那时候用户已经在等了。
RUN cd build \
 && npm install --no-save typescript@5.9.3 @types/node@26.1.1 @types/ws@8.18.1 ws@8.21.1 \
 && npx tsc \
 && cp -r dist/agent-runtime/src /opt/cassia/runtime \
 && mkdir -p /opt/cassia/node_modules/@cassia/shared \
 && cp -r dist/shared/src /opt/cassia/node_modules/@cassia/shared/src \
 && cd / && rm -rf /opt/cassia/build

# tsc 的 paths 只影响类型解析，产物里 "@cassia/shared" 这个裸标识符
# 原样保留 —— 所以要在 node_modules 里放一个真包让 node 能解析到。
RUN printf '%s' '{"name":"@cassia/shared","version":"0.1.0","type":"module","exports":{".":"./src/index.js"}}' > /opt/cassia/node_modules/@cassia/shared/package.json \
 && node -e "import('/opt/cassia/node_modules/@cassia/shared/src/index.js').then(m=>{if(typeof m.nid!=='function')process.exit(1);console.log('shared OK')})"

# 收尾完整性断言：pi 全局包必须在**所有 npm install 之后**依然完好
# （arborist 的修剪行为曾把它清空过），扩展文件和 node-pty 也要在。
RUN test -f /usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js \
 && pi --version \
 && node -e "const p=require('node-pty'); if(typeof p.spawn!=='function')process.exit(1)" \
 && node -e "const t=require('typebox'); if(typeof t.Type!=='object')process.exit(1)" \
 && test -f /opt/cassia/pi-extension/persistent-shell.ts \
 && test -f /opt/cassia/pi-extension/plan.ts \
 && echo 'integrity OK'

COPY sandbox-lite/start.sh /opt/cassia/start.sh
RUN chmod +x /opt/cassia/start.sh

# Agent 的工作目录。每个会话在它下面开一个以 sessionId 命名的子目录。
RUN mkdir -p /home/user/workspace
ENV WORKSPACE=/home/user/workspace \
    PORT=8330 \
    NODE_ENV=production

EXPOSE 8330
