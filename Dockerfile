FROM node:24-slim@sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7

LABEL io.homeserver.monitoring.service="fredy" \
      io.homeserver.monitoring.metrics-port="9217" \
      io.homeserver.monitoring.metrics-path="/metrics" \
      io.homeserver.monitoring.dashboard="/opt/homeserver-monitoring/grafana-dashboard.json"

# System deps for CloakBrowser + build tools for native modules (better-sqlite3)
# fonts-* packages below are CloakBrowser's recommended Linux font set
# (https://github.com/CloakHQ/cloakbrowser#font-setup-on-linux): sites like
# Kasada/Akamai render emoji/CJK glyphs on hidden canvases and hash the pixel
# output, so missing fonts produce hashes a minimal Linux image can't match.
# NOTE: Real Windows fonts (Segoe UI, Calibri, etc.) can't be bundled here since
# they require copying licensed files off an actual Windows install; the
# resulting CLOAKBROWSER_SUPPRESS_FONT_WARNING startup notice is expected.
# python3 stays in the final image: the market GBM trainer
# (tools/market/train_gbm.py) runs as a short-lived nightly batch process.
# libgomp1 is LightGBM's OpenMP runtime; python3-venv isolates the pinned
# trainer deps from Debian's PEP 668-managed system Python.
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates fonts-liberation libasound2 \
    libatk-bridge2.0-0 libatk1.0-0 libcups2 libdbus-1-3 \
    libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 \
    libx11-xcb1 libxcomposite1 libxdamage1 libxrandr2 xdg-utils \
    fonts-noto-color-emoji fonts-freefont-ttf fonts-unifont \
    fonts-ipafont-gothic fonts-wqy-zenhei fonts-tlwg-loma-otf \
    python3 python3-venv libgomp1 \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /db /conf /fredy

WORKDIR /fredy

ENV NODE_ENV=production \
    IS_DOCKER=true \
    CLOAKBROWSER_SUPPRESS_FONT_WARNING=1

COPY package.json yarn.lock ./

# make/g++ exist only to compile better-sqlite3. They are installed, used, and
# purged inside a SINGLE layer on purpose: a purge in a *later* layer leaves the
# bytes in the earlier one, so the image keeps carrying them (~520 MB here).
# python3 is deliberately not touched — the market GBM trainer needs it at runtime.
RUN apt-get update \
  && apt-get install -y --no-install-recommends make g++ \
  && yarn config set network-timeout 600000 \
  && yarn --frozen-lockfile --production --ignore-scripts \
  && npm rebuild better-sqlite3 sharp \
  && yarn cache clean \
  && apt-get purge -y make g++ \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*

# Pinned venv for the market GBM trainer. The requirements file is shared with
# local setup so the container and a clean checkout cannot train on different
# Python stacks.
COPY tools/market/requirements.txt ./tools/market/requirements.txt

RUN python3 -m venv /opt/market-venv \
  && /opt/market-venv/bin/pip install --no-cache-dir -r tools/market/requirements.txt \
  && /opt/market-venv/bin/python3 -c "import lightgbm, numpy"

ENV FREDY_PYTHON_BIN=/opt/market-venv/bin/python3

COPY lib ./lib

# Create the runtime identity before downloading browser state so both the
# bundled binary and fresh anonymous /db and /conf volumes are usable without
# root.
RUN groupadd -g 10001 homeserver \
  && useradd -u 10001 -g homeserver -d /home/homeserver -m -s /usr/sbin/nologin homeserver \
  && chown 10001:10001 /db /conf

ENV HOME=/home/homeserver \
    XDG_CACHE_HOME=/home/homeserver/.cache \
    XDG_CONFIG_HOME=/home/homeserver/.config

# Pre-download the CloakBrowser stealth Chromium binary (supports x86_64 and arm64)
RUN node -e "import('cloakbrowser').then(({ensureBinary}) => ensureBinary())" \
  && chown -R 10001:10001 /home/homeserver

COPY index.js ./
COPY tools ./tools
COPY monitoring/grafana-dashboard.json /opt/homeserver-monitoring/grafana-dashboard.json

RUN ln -s /db /fredy/db \
  && ln -s /conf /fredy/conf

USER 10001:10001

EXPOSE 9998
VOLUME /db
VOLUME /conf

HEALTHCHECK --interval=30s --timeout=10s --start-period=5m --retries=3 \
  CMD curl --fail --silent --show-error --max-time 5 http://localhost:9998/health || exit 1

CMD ["node", "index.js"]
