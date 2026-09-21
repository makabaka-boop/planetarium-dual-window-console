import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { makeBrokenJpeg, makePng } from './fixtures';

const ACK_TIMEOUT_MS = '600';

async function newConsole(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.addInitScript((ms) => {
    window.localStorage.setItem('dome:ackTimeoutMs', ms);
  }, ACK_TIMEOUT_MS);
  await page.goto('/index.html');
  return page;
}

async function importImages(
  consolePage: Page,
  files: { name: string; mimeType: string; buffer: Buffer }[],
): Promise<void> {
  await consolePage
    .getByTestId('file-input')
    .setInputFiles(files.map((f) => ({ name: f.name, mimeType: f.mimeType, buffer: f.buffer })));
  await expect(consolePage.getByTestId('page-list').getByTestId('page-row')).toHaveCount(files.length);
}

async function startAndOpenViewer(consolePage: Page): Promise<Page> {
  await consolePage.getByTestId('start').click();
  await expect(consolePage.getByTestId('phase')).toContainText('放映中');

  const popupPromise = consolePage.waitForEvent('popup');
  await consolePage.getByTestId('open-viewer').click();
  const viewer = await popupPromise;
  await viewer.waitForLoadState();
  await expect(viewer.getByTestId('viewer')).toHaveAttribute('data-phase', 'LIVE');
  return viewer;
}

test.beforeEach(async ({ context }) => {
  // 干净的 IndexedDB / BroadcastChannel 环境。
  await context.clearCookies();
});

test('编排导入、放映、上下页、跳页与遮黑：控制台标记与穹顶画面收敛', async ({ context }) => {
  const consolePage = await newConsole(context);
  await importImages(consolePage, [
    { name: 'a.png', mimeType: 'image/png', buffer: makePng(255, 0, 0) },
    { name: 'b.png', mimeType: 'image/png', buffer: makePng(0, 255, 0) },
    { name: 'c.png', mimeType: 'image/png', buffer: makePng(0, 0, 255) },
  ]);

  const viewer = await startAndOpenViewer(consolePage);

  // 初始无已呈现页
  await expect(consolePage.getByTestId('now-playing')).toContainText('尚未呈现');

  // 跳页到第 2 页：命令经历待确认 -> 已确认
  await consolePage.getByTestId('jump').nth(1).click();
  await expect(consolePage.getByTestId('cmd-entry').first()).toHaveAttribute('data-status', 'CONFIRMED');
  await expect(viewer.getByTestId('viewer')).toHaveAttribute('data-page-id', await pageIdAt(consolePage, 1));
  await expect(viewer.getByTestId('dome-image')).toBeVisible();

  // 控制台“穹顶正在呈现”标记落在第 2 行，与穹顶实际画面一致
  await expect(
    consolePage.getByTestId('page-row').nth(1).getByTestId('presented-mark'),
  ).toBeVisible();
  await expect(
    consolePage.getByTestId('page-row').nth(0).getByTestId('presented-mark'),
  ).toHaveCount(0);

  // 下页 -> 第 3 页
  await consolePage.getByTestId('next').click();
  await expect(consolePage.getByTestId('cmd-entry').first()).toHaveAttribute('data-status', 'CONFIRMED');
  await expect(viewer.getByTestId('viewer')).toHaveAttribute('data-page-id', await pageIdAt(consolePage, 2));

  // 上页 -> 第 2 页
  await consolePage.getByTestId('prev').click();
  await expect(viewer.getByTestId('viewer')).toHaveAttribute('data-page-id', await pageIdAt(consolePage, 1));

  // 遮黑：穹顶全黑，控制台权威画面显示“遮黑”，已呈现标记消失
  await consolePage.getByTestId('blackout').click();
  await expect(viewer.getByTestId('blackout-layer')).toBeVisible();
  await expect(consolePage.getByTestId('now-playing')).toContainText('遮黑');
  await expect(consolePage.getByTestId('blackout')).toHaveAttribute('data-blackout', '1');
  await expect(consolePage.getByTestId('presented-mark')).toHaveCount(0);

  // 解除遮黑：回到遮黑前那一页（第 2 页），而非首页
  await consolePage.getByTestId('blackout').click();
  await expect(viewer.getByTestId('blackout-layer')).toHaveCount(0);
  await expect(viewer.getByTestId('viewer')).toHaveAttribute('data-page-id', await pageIdAt(consolePage, 1));
  await expect(consolePage.getByTestId('page-row').nth(1).getByTestId('presented-mark')).toBeVisible();
});

test('单张解码失败只标记该项；放映呈现失败回传 FAIL，最后成功页不变', async ({ context }) => {
  const consolePage = await newConsole(context);
  await importImages(consolePage, [
    { name: 'ok.png', mimeType: 'image/png', buffer: makePng(10, 200, 120) },
    { name: 'broken.jpg', mimeType: 'image/jpeg', buffer: makeBrokenJpeg() },
  ]);

  // 编排列表里坏图被单独标记，好图正常
  const rows = consolePage.getByTestId('page-row');
  await expect(rows.nth(0)).not.toHaveClass(/broken/);
  await expect(rows.nth(1)).toHaveClass(/broken/);
  await expect(rows.nth(1)).toContainText('解码失败');

  const viewer = await startAndOpenViewer(consolePage);

  // 先成功呈现第 1 页
  await consolePage.getByTestId('jump').nth(0).click();
  await expect(consolePage.getByTestId('cmd-entry').first()).toHaveAttribute('data-status', 'CONFIRMED');
  const firstPageId = await pageIdAt(consolePage, 0);
  await expect(viewer.getByTestId('viewer')).toHaveAttribute('data-page-id', firstPageId);

  // 跳到坏页：FAIL 回传，穹顶停在最后成功页
  await consolePage.getByTestId('jump').nth(1).click();
  await expect(consolePage.getByTestId('cmd-entry').first()).toHaveAttribute('data-status', 'FAILED');
  await expect(viewer.getByTestId('viewer')).toHaveAttribute('data-page-id', firstPageId);
  await expect(consolePage.getByTestId('now-playing')).toContainText(/第 1/);
});

test('观众窗刷新：恢复期间无旧画面，随后收敛到最后已确认页与遮黑快照', async ({ context }) => {
  const consolePage = await newConsole(context);
  await importImages(consolePage, [
    { name: 'a.png', mimeType: 'image/png', buffer: makePng(255, 0, 0) },
    { name: 'b.png', mimeType: 'image/png', buffer: makePng(0, 255, 0) },
  ]);
  const viewer = await startAndOpenViewer(consolePage);

  await consolePage.getByTestId('jump').nth(1).click();
  const secondPageId = await pageIdAt(consolePage, 1);
  await expect(viewer.getByTestId('viewer')).toHaveAttribute('data-page-id', secondPageId);

  await consolePage.getByTestId('blackout').click();
  await expect(viewer.getByTestId('blackout-layer')).toBeVisible();

  // 刷新观众窗：必须先经过“恢复中”（无旧星图），再恢复到遮黑 + 第 2 页
  await viewer.reload();
  await expect(viewer.getByTestId('recovering')).toBeVisible();
  await expect(viewer.getByTestId('viewer')).toHaveAttribute('data-phase', 'LIVE');
  await expect(viewer.getByTestId('blackout-layer')).toBeVisible();
  await expect(viewer.getByTestId('viewer')).toHaveAttribute('data-page-id', secondPageId);
  await expect(viewer.getByTestId('viewer')).toHaveAttribute('data-blackout', '1');

  // 解除遮黑：控制台与穹顶仍然同步（快照已带 lastSeq，后续序号接续正确）
  await consolePage.getByTestId('blackout').click();
  await expect(viewer.getByTestId('blackout-layer')).toHaveCount(0);
  await expect(viewer.getByTestId('viewer')).toHaveAttribute('data-page-id', secondPageId);
  await expect(consolePage.getByTestId('cmd-entry').first()).toHaveAttribute('data-status', 'CONFIRMED');
});

test('重开观众窗：控制台已呈现标记与穹顶画面收敛到同一权威状态', async ({ context }) => {
  const consolePage = await newConsole(context);
  await importImages(consolePage, [
    { name: 'a.png', mimeType: 'image/png', buffer: makePng(255, 0, 0) },
    { name: 'b.png', mimeType: 'image/png', buffer: makePng(0, 255, 0) },
  ]);
  let viewer = await startAndOpenViewer(consolePage);

  await consolePage.getByTestId('jump').nth(1).click();
  const secondPageId = await pageIdAt(consolePage, 1);
  await expect(viewer.getByTestId('viewer')).toHaveAttribute('data-page-id', secondPageId);

  // 关闭后重开
  await viewer.close();
  const popupPromise = consolePage.waitForEvent('popup');
  await consolePage.getByTestId('open-viewer').click();
  viewer = await popupPromise;
  await expect(viewer.getByTestId('viewer')).toHaveAttribute('data-phase', 'LIVE');

  // 穹顶直接是第 2 页（不是空白也不是第 1 页）；控制台标记仍在第 2 行
  await expect(viewer.getByTestId('viewer')).toHaveAttribute('data-page-id', secondPageId);
  await expect(
    consolePage.getByTestId('page-row').nth(1).getByTestId('presented-mark'),
  ).toBeVisible();

  // 重开后翻页仍正常确认
  await consolePage.getByTestId('prev').click();
  const firstPageId = await pageIdAt(consolePage, 0);
  await expect(viewer.getByTestId('viewer')).toHaveAttribute('data-page-id', firstPageId);
  await expect(consolePage.getByTestId('cmd-entry').first()).toHaveAttribute('data-status', 'CONFIRMED');
});

test('未确认超时显示 UNCONFIRMED；重试沿用原序号并收敛', async ({ context }) => {
  const consolePage = await newConsole(context);
  await importImages(consolePage, [
    { name: 'a.png', mimeType: 'image/png', buffer: makePng(255, 0, 0) },
    { name: 'b.png', mimeType: 'image/png', buffer: makePng(0, 255, 0) },
  ]);
  const viewer = await startAndOpenViewer(consolePage);

  // 关闭观众窗后发命令：无人确认，控制台必须走到“未确认”。
  await viewer.close();

  await consolePage.getByTestId('jump').nth(0).click();
  await expect(consolePage.getByTestId('cmd-entry').first()).toHaveAttribute(
    'data-status',
    'UNCONFIRMED',
    { timeout: 5000 },
  );

  // 重开观众窗：它拿到快照（此时无已确认页），控制台重试沿用序号 #1
  const popupPromise = consolePage.waitForEvent('popup');
  await consolePage.getByTestId('open-viewer').click();
  const reopened = await popupPromise;
  await expect(reopened.getByTestId('viewer')).toHaveAttribute('data-phase', 'LIVE');

  await consolePage.getByTestId('cmd-retry').first().click();
  await expect(consolePage.getByTestId('cmd-entry').first()).toHaveAttribute('data-status', 'CONFIRMED');
  const firstPageId = await pageIdAt(consolePage, 0);
  await expect(reopened.getByTestId('viewer')).toHaveAttribute('data-page-id', firstPageId);
});

test('恢复期间其他会话与旧 reqId 的快照应答均无效', async ({ context }) => {
  const consolePage = await newConsole(context);
  await importImages(consolePage, [
    { name: 'a.png', mimeType: 'image/png', buffer: makePng(255, 0, 0) },
    { name: 'b.png', mimeType: 'image/png', buffer: makePng(0, 255, 0) },
  ]);
  const viewer = await startAndOpenViewer(consolePage);
  await consolePage.getByTestId('jump').nth(0).click();
  const firstPageId = await pageIdAt(consolePage, 0);
  await expect(viewer.getByTestId('viewer')).toHaveAttribute('data-page-id', firstPageId);

  // 刷新后、守卫时窗内，从页面注入异会话/旧 reqId 的伪造快照，必须全部被丢弃。
  await viewer.reload();
  await expect(viewer.getByTestId('recovering')).toBeVisible();
  const secondPageId = await pageIdAt(consolePage, 1);
  await viewer.evaluate(
    ([first, second]) => {
      const ch = new BroadcastChannel('dome-presenter/v1');
      const sid = new URLSearchParams(location.search).get('sid')!;
      // 1) 其他会话的快照：必须忽略
      ch.postMessage({
        type: 'SNAPSHOT_RES',
        sessionId: 'some-other-session',
        reqId: 'whatever',
        pageId: second,
        blackout: false,
        lastSeq: 99,
        pages: [first, second].map((id, i) => ({ id, name: `fake-${i}`, decodeBroken: false })),
      });
      // 2) 同会话但旧 reqId 的“迟到快照”：必须忽略
      ch.postMessage({
        type: 'SNAPSHOT_RES',
        sessionId: sid,
        reqId: 'stale-req-from-previous-load',
        pageId: second,
        blackout: true,
        lastSeq: 77,
        pages: [first, second].map((id, i) => ({ id, name: `old-${i}`, decodeBroken: false })),
      });
    },
    [firstPageId, secondPageId],
  );

  // 合法快照到达后恢复到真正的权威状态（第 1 页，未遮黑）
  await expect(viewer.getByTestId('viewer')).toHaveAttribute('data-phase', 'LIVE');
  await expect(viewer.getByTestId('viewer')).toHaveAttribute('data-page-id', firstPageId);
  await expect(viewer.getByTestId('viewer')).toHaveAttribute('data-blackout', '0');
});

test('弹窗受阻显示 POPUP_BLOCKED 且会话保留，允许弹窗后可重开', async ({ page }) => {
  // 通过 CSP / 脚本拦截 window.open 模拟浏览器拦截。
  await page.addInitScript(() => {
    window.localStorage.setItem('dome:ackTimeoutMs', '600');
    const original = window.open.bind(window);
    window.open = ((..._args: unknown[]) => {
      // 第一次调用返回 null（被拦截）；测试中直接验证 BLOCKED 状态即可
      return null as unknown as Window | null;
    }) as typeof window.open;
    void original;
  });
  await page.goto('/index.html');
  await importImages(page, [
    { name: 'a.png', mimeType: 'image/png', buffer: makePng(1, 2, 3) },
  ]);

  await page.getByTestId('start').click();
  await page.getByTestId('open-viewer').click();
  await expect(page.getByTestId('popup-status')).toHaveAttribute('data-status', 'BLOCKED');
  await expect(page.getByTestId('popup-status')).toContainText('POPUP_BLOCKED');

  // 会话仍在：放映中徽标与控制面板保留
  await expect(page.getByTestId('phase')).toContainText('放映中');
  await expect(page.getByTestId('show-controls')).toBeVisible();
});

test('节目单与图片 Blob 持久化：控制台刷新后可恢复，开始放映即冻结', async ({ context }) => {
  let consolePage = await newConsole(context);
  await importImages(consolePage, [
    { name: 'persist.png', mimeType: 'image/png', buffer: makePng(9, 9, 9) },
  ]);
  await expect(
    consolePage.getByTestId('page-row').locator('input.page-name-input'),
  ).toHaveValue('persist.png');

  // 刷新控制台：节目单从 IndexedDB 恢复
  await consolePage.reload();
  await expect(consolePage.getByTestId('page-row')).toHaveCount(1);
  await expect(
    consolePage.getByTestId('page-row').locator('input.page-name-input'),
  ).toHaveValue('persist.png');

  // 开始放映后冻结：列表操作按钮全部禁用，新增文件入口消失
  const viewer = await startAndOpenViewer(consolePage);
  await expect(consolePage.getByTestId('uploader')).toHaveCount(0);
  const moveBtn = consolePage.getByTestId('page-row').getByRole('button', { name: '上移' });
  await expect(moveBtn).toBeDisabled();
  await viewer.close();
});

async function pageIdAt(consolePage: Page, index: number): Promise<string> {
  return consolePage
    .getByTestId('page-list')
    .getByTestId('page-row')
    .nth(index)
    .getAttribute('data-page-id') as Promise<string>;
}
