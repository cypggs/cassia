# cassia —— 带真实桌面的沙箱镜像。lite 的超集。
#
# = lite（Node + pi + agent-runtime）
# + Xvfb + openbox + x11vnc + websockify   ← 画面
# + 常驻 Chromium（CDP 9222）+ Playwright   ← Agent 能操作的浏览器
# + supervisord                            ← 进程编排
#
# 构建：cd ~/cassia && ./sandbox-desktop/build.sh
#
# ── 两个有意的取舍 ──
#
# **单阶段。** E2B 的 CLI 自己解析 Dockerfile 而不是调 docker build，
# 多阶段直接报 "Multi-stage Dockerfiles are not supported"。
#
# **画面走 VNC 不走 neko（WebRTC）。** neko 延迟更低，但它要自定义
# X 输入驱动 + GStreamer + Pulse 一整套。VNC 能力上是够的（画面、输入都有），
# 换来的是构建从二十几分钟降到几分钟、依赖面小一个数量级。
# neko 是延迟优化，不是能力前提 —— 已搁置（Agent 自操作为主）。
#
# 镜像里**没有任何密钥**，理由同 lite。

FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8

# ── Layer 1：CLI 工具（和 lite 一致）
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl wget git jq unzip zip less procps \
      python3 python3-pip python3-venv \
      ripgrep tree file \
 && rm -rf /var/lib/apt/lists/*

# ── Layer 2：桌面栈
# x11-utils 提供 xdpyinfo（wait-x.sh 用它判断 X 是否真就绪）；
# x11-apps 提供 xwd —— 用来抓 X 的原始帧，验证画面上真有东西而不是黑屏；
# xdotool / xclip 是给 Agent 用的 —— 它可以直接在终端里操作桌面。
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb x11vnc x11-utils x11-apps openbox xdotool xclip \
      websockify supervisor \
      chromium \
      fonts-liberation fonts-noto-color-emoji fonts-noto-cjk \
      dbus-x11 \
 && rm -rf /var/lib/apt/lists/*

# fonts-noto-cjk 不是可选的：没有它，Agent 打开任何中文页面，
# 用户在画面里看到的是一整屏豆腐块。

# ── Layer 3：Node 版本下限
# pi 要求 node >= 22.19.0。构建期断言一次，免得换基础镜像时静默退化。
RUN node -e "const [a,b]=process.versions.node.split('.').map(Number); if (a<22 || (a===22 && b<19)) { console.error('node '+process.versions.node+' < 22.19.0 (pi 的下限)'); process.exit(1) } console.log('node '+process.versions.node+' OK')"

# ── Layer 4：pi + 运行时依赖（最慢的一层，放在代码之前保住缓存）
WORKDIR /opt/cassia
RUN npm init -y > /dev/null \
 && npm pkg set type=module \
 && npm install ws@8.21.1 \
 && npm install typebox@1.1.38 \
 && npm install -g @earendil-works/pi-coding-agent@1.2.0 \
 && npm cache clean --force \
 && pi --version

# ── Layer 4b：node-pty（持久 shell 扩展的原生模块）
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

# ── Layer 5：Playwright
# PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD —— Agent 是通过 CDP 接管那个**已经在
# 画面上跑着的** Chromium，不是自己再下一个。少下 400MB，
# 更重要的是保证「Agent 操作的浏览器」和「用户看到的浏览器」是同一个。
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm install -g playwright-core@1.58.0 && npm cache clean --force

# ── Layer 6：编译 agent-runtime
COPY shared/src ./build/shared/src
COPY agent-runtime/src ./build/agent-runtime/src
COPY sandbox-lite/tsconfig.build.json ./build/tsconfig.json
# 扩展不编译 —— pi 自己的加载器直接吃 TS（本机探针验证过），
# 而且它依赖 pi 包提供的 createBashTool，编译时解析不到。
COPY agent-runtime/pi-extension ./pi-extension
RUN cd build \
 && npm install --no-save typescript@5.9.3 @types/node@26.1.1 @types/ws@8.18.1 ws@8.21.1 \
 && npx tsc \
 && cp -r dist/agent-runtime/src /opt/cassia/runtime \
 && mkdir -p /opt/cassia/node_modules/@cassia/shared \
 && cp -r dist/shared/src /opt/cassia/node_modules/@cassia/shared/src \
 && cd / && rm -rf /opt/cassia/build

# tsc 的 paths 只影响类型解析，产物里 "@cassia/shared" 原样保留，
# 所以要在 node_modules 里放一个真包让 node 解析得到。
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

# ── Layer 7：编排脚本
COPY sandbox-desktop/bin/ /opt/cassia-desktop/bin/
COPY sandbox-desktop/supervisord.conf /opt/cassia-desktop/supervisord.conf
COPY sandbox-desktop/start.sh /opt/cassia-desktop/start.sh
RUN chmod +x /opt/cassia-desktop/bin/*.sh /opt/cassia-desktop/start.sh

# supervisord 不做 PATH 查找，conf 里写的是绝对路径。路径写错的表现很隐蔽：
# 桌面栈照样全绿，只有一行 spawnerr 混在日志里，看着像「起来了」。
# 所以在构建期把 conf 里的每个绝对路径都验一遍。
RUN grep -oE '^command=[^ ]+' /opt/cassia-desktop/supervisord.conf | cut -d= -f2 | sort -u | \
    while read -r c; do \
      test -x "$c" || { echo "supervisord.conf 引用了不存在或不可执行的命令: $c"; exit 1; }; \
      echo "ok $c"; \
    done

# ── Layer 8：运行期目录与环境
# 这些目录要归 user —— E2B 在模板末尾追加 USER user，
# 之后所有进程都以它身份跑，root 建的目录写不进去。
RUN mkdir -p /home/user/workspace /home/user/.supervisor /home/user/.chromium \
 && chown -R user:user /home/user /opt/cassia 2>/dev/null || true

ENV WORKSPACE=/home/user/workspace \
    PORT=8330 \
    DISPLAY=:1 \
    SCREEN_GEOMETRY=1280x800x24 \
    NODE_ENV=production

EXPOSE 8330 5901 9222
