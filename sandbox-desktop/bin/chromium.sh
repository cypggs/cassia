#!/bin/bash
# 常驻 Chromium：既是用户在「画面」tab 里看到的东西，
# 也是 Agent 通过 CDP 接管的那个实例。同一个进程，所以 Agent 的每一次
# 点击、跳转、滚动都直接显示在画面上 —— 这正是「Agent 拥有一台电脑」
# 该有的观感。headless 跑一个、画面上再放一个是两台电脑，那就假了。
#
# --test-type 是为了压掉那条黄色警告条「您正在使用不受支持的命令行标记
# --no-sandbox」。--disable-infobars 对它无效。这条不是洁癖：那个横幅会
# 一直挂在用户看到的画面顶上，还带个关闭按钮，看着像是出了什么错。
set -euo pipefail

export DISPLAY="${DISPLAY:-:1}"
GEOM="${SCREEN_GEOMETRY:-1280x800x24}"
W="${GEOM%%x*}"
H="${GEOM#*x}"; H="${H%%x*}"

/opt/cassia-desktop/bin/wait-x.sh true

exec /usr/bin/chromium \
  --no-sandbox \
  --test-type \
  --disable-dev-shm-usage \
  --disable-gpu \
  --remote-debugging-port=9222 \
  --remote-allow-origins=* \
  --user-data-dir=/home/user/.chromium \
  --window-position=0,0 \
  --window-size="${W},${H}" \
  --no-first-run \
  --no-default-browser-check \
  --disable-session-crashed-bubble \
  --disable-infobars \
  --disable-features=TranslateUI,ChromeWhatsNewUI \
  about:blank
