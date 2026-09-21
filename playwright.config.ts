import { defineConfig, devices } from '@playwright/test';

// Docker 内由 compose 的 verify 服务负责提供页面（WEB_PORT 默认 8080），
// 此时不再自行启动 webServer；本地运行时自动拉起 preview。
const baseURL = process.env.E2E_BASE_URL || `http://localhost:${process.env.WEB_PORT || '8080'}`;
const inDocker = !!process.env.E2E_BASE_URL || !!process.env.DOCKER;

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL,
    trace: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: inDocker
    ? undefined
    : {
        command: 'npm run build && npm run preview',
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
