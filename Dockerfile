FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    NPM_CONFIG_YES=true \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/local/bin/hyperframes-chromium \
    HYPERFRAMES_BROWSER_PATH=/usr/local/bin/hyperframes-chromium \
    HF_WORKSPACE=/workspace/projects \
    HYPERFRAMES_BIN=/usr/local/bin/hyperframes

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium ffmpeg unzip ca-certificates fonts-liberation fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

# Render Docker Web Services provide only ~64 MB /dev/shm. Chromium needs more
# for its default shared-memory path. We launch with a wrapper that:
# - disables /dev/shm usage (writes temp files under /tmp instead)
# - disables the sandbox (common requirement in restricted containers)
# - disables GPU (no GPU available on Render free tier)
# - uses a single process to reduce memory pressure
# This avoids requiring docker --shm-size, which Render does not expose.
RUN printf '%s\n' \
    '#!/bin/sh' \
    'exec /usr/bin/chromium \' \
    '  --disable-dev-shm-usage \' \
    '  --no-sandbox \' \
    '  --disable-gpu \' \
    '  --disable-software-rasterizer \' \
    '  --disable-extensions \' \
    '  --disable-background-networking \' \
    '  --single-process \' \
    '  "$@"' \
    > /usr/local/bin/hyperframes-chromium && \
    chmod +x /usr/local/bin/hyperframes-chromium

RUN npm install -g hyperframes@0.8.33 && \
    test -x /usr/local/bin/hyperframes && \
    hyperframes --version

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

COPY src ./src
COPY README.md ./README.md
RUN mkdir -p /workspace/projects

EXPOSE 10000
CMD ["node", "src/server.js"]
