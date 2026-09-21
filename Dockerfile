# 纯前端静态站点 + Playwright 验收环境
FROM node:20-bookworm-slim AS deps
WORKDIR /app

# Playwright Chromium 运行所需系统库
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    fonts-liberation \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libdbus-1-3 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libcairo2 \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .
RUN npx playwright install chromium && npm run build

ENV WEB_PORT=8080
EXPOSE 8080

# 默认提供静态页面；compose 的 verify 服务会覆盖命令执行一次性验收。
CMD ["sh", "-c", "npx vite preview --host 0.0.0.0 --port ${WEB_PORT}"]
