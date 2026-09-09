FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    NPM_CONFIG_YES=true \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    HYPERFRAMES_BROWSER_PATH=/usr/bin/chromium \
    HF_WORKSPACE=/workspace/projects \
    PATH=/app/node_modules/.bin:$PATH

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium ffmpeg unzip ca-certificates fonts-liberation fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev && \
    test -x /app/node_modules/.bin/hyperframes && \
    node -e "const fs=require('fs'); console.log(fs.realpathSync('/app/node_modules/.bin/hyperframes'))"

COPY src ./src
COPY README.md ./README.md
RUN mkdir -p /workspace/projects

EXPOSE 10000
CMD ["node", "src/server.js"]
