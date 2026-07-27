FROM node:22-slim

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
  && yarn --frozen-lockfile \
  && yarn cache clean \
  && apt-get purge -y make g++ \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*

# Pinned venv for the market GBM trainer. If this venv is missing or broken
# at runtime the GBM family simply skips training (the ridge family and the
# whole scrape/notify pipeline are unaffected).
RUN python3 -m venv /opt/market-venv \
  && /opt/market-venv/bin/pip install --no-cache-dir numpy==2.4.6 lightgbm==4.6.0 \
  && /opt/market-venv/bin/python3 -c "import lightgbm, numpy"

ENV FREDY_PYTHON_BIN=/opt/market-venv/bin/python3

COPY index.html vite.config.js ./
COPY ui ./ui
COPY lib ./lib

RUN yarn build:frontend

# The ADD re-fetches the npm manifest on every build, so this layer's cache
# busts exactly when a new CloakBrowser version is published — each deploy
# rebuild then installs the latest release (bot-detection evasion decays fast).
# Runs AFTER the frontend build: with NODE_ENV=production npm prunes the dev
# dependencies (vite, less, ...) that the build still needs.
# --legacy-peer-deps: pre-existing dev peer conflict (eslint 10 vs
# eslint-plugin-react) otherwise aborts the install.
ADD https://registry.npmjs.org/cloakbrowser/latest /tmp/cloakbrowser-latest.json
RUN npm install --no-audit --no-fund --no-save --legacy-peer-deps cloakbrowser@latest

# Pre-download the CloakBrowser stealth Chromium binary (supports x86_64 and arm64)
RUN node -e "import('cloakbrowser').then(({ensureBinary}) => ensureBinary())"

COPY index.js ./
COPY tools ./tools

# Dedicated unprivileged user so the hardened homeserver compose
# (user: 10001:10001, read-only rootfs) works out of the box.
RUN groupadd -g 10001 homeserver \
  && useradd -u 10001 -g homeserver -d /home/homeserver -M -s /usr/sbin/nologin homeserver \
  && install -d -o 10001 -g 10001 /home/homeserver

RUN ln -s /db /fredy/db \
  && ln -s /conf /fredy/conf

EXPOSE 9998
VOLUME /db
VOLUME /conf

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD curl --fail --silent --show-error --max-time 5 http://localhost:9998/health || exit 1

CMD ["node", "index.js"]
