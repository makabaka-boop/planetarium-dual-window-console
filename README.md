# 穹顶讲解（Dome Presenter）

纯前端（React + TypeScript + Vite）的星图讲解系统，**无后端、无任何外部调用**。
讲解员在控制台编排本地 PNG/JPEG 节目单并控制放映；穹顶观众窗以多窗口方式呈现。
两窗之间仅用同源 `BroadcastChannel` 通信，图片 Blob 存于 IndexedDB。

## 快速开始

```bash
npm ci
npm run dev          # 开发服务器（默认 http://localhost:8080 ）
npm run build        # 类型检查 + 构建
npm run preview      # 预览构建产物
```

打开控制台后：

1. **编排**：选择本地 PNG/JPEG（可多选）。逐张解码探测，失败的单张仅标记“解码失败”，不影响其余项；可重命名、上下移、删除。自动保存到 IndexedDB，刷新可恢复。
2. **开始放映**：节目单在这一刻**冻结快照**；之后的增删改只落库，供下一会话使用，当前穹顶绝不因编辑而跳图。
3. **打开观众窗**：弹出 `/viewer.html?sid=<会话ID>`。被浏览器拦截时显示 `POPUP_BLOCKED`，会话完整保留，允许弹窗后重试即可。
4. **放映控制**：上页 / 下页 / 数字跳页 / 遮黑。每条命令携带会话 ID 与会话内递增序号。

## 放映协议（src/protocol）

纯函数状态机，分别由 Vitest 核验：

| 文件 | 职责 |
| --- | --- |
| `protocol/types.ts` | 消息格式（`GOTO` / `SET_BLACKOUT` / `ACK` / `SNAPSHOT_REQ` / `SNAPSHOT_RES`）、类型守卫 |
| `protocol/presenter.ts` | 控制台状态机：序号、待确认/未确认/已确认/失败、冻结、快照构造 |
| `protocol/viewer.ts` | 观众窗状态机：恢复守卫、去重去旧、解码成功才提交 |

### 序号与确认（停等协议）

- 序号在会话内从 1 递增，同一时刻只有一条在飞命令；匹配确认到达前控制台显示**待确认**，
  超时（默认 4s，可用 `localStorage['dome:ackTimeoutMs']` 调整）显示**未确认**。
- 控制台权威画面（已呈现标记、遮黑指示）**只在收到匹配确认后更新**，不会误报尚未呈现的页。
- **重试沿用原序号**。观众窗对已应用的同序号命令幂等重发 ACK，不重复呈现；
  更旧或重复消息一律忽略。
- 图片呈现失败回 `ACK FAIL (IMAGE_FAILED)`：该序号终结，但**最后成功页不变**；
  FAILED 是终结态，需要重新下指令（得到新序号）；未确认才是同序号重试。

### 刷新 / 重开与恢复

- 观众窗加载后进入 **RECOVERING**，主动发 `SNAPSHOT_REQ`（带一次性 `reqId`，定时重发），
  恢复屏期间不显示任何旧画面（含最小 300ms 守卫时窗，杜绝刷新瞬间的旧星图闪烁）。
- 控制台回传**完整快照**：冻结节目单 + 最后已确认页 + 遮黑状态 + 已确认序号 `lastSeq`。
- 只有会话 ID 与 `reqId` **同时匹配**的快照才被接受；恢复期间旧命令、旧确认、
  其他会话消息（含伪造的异会话/旧 reqId 快照）全部无效。
- `lastSeq` 保证重开后控制台按原序号重试的命令被识别为幂等重复，下一条序号正确接续——
  重开后控制台的已呈现标记与穹顶实际画面收敛到同一权威状态。

### 弹窗受阻

`window.open` 返回 null 即置 `POPUP_BLOCKED`：放映会话、节目单快照、命令记录全部保留，
仅观众窗缺席；解除拦截后重试打开即可恢复。

## 测试

```bash
npm run test          # Vitest：协议状态机（31 个用例）
npm run e2e           # Playwright：多窗口端到端（8 个场景）
npm run verify        # 单元测试 + 构建 + Playwright 一次性验收
```

Playwright 覆盖：编排/翻页/跳页/遮黑收敛、单张坏图标记与 FAIL 不回退、
观众窗刷新的恢复守卫与快照、重开收敛、超时未确认与同序号重试、
恢复期间异会话/旧 reqId 消息无效、POPUP_BLOCKED、IndexedDB 持久化与冻结。

## Docker Compose

`WEB_PORT` 可覆盖（默认 8080）：

```bash
docker compose up --build                 # 提供静态页面
WEB_PORT=9090 docker compose up --build   # 自定义端口
docker compose run --rm verify            # 一次性验收服务（vitest + build + playwright）
```

- `web`：仅静态文件服务（`vite preview`），无后端、无外调。
- `verify`：一次性服务，针对 `web` 跑完单元测试、构建与多窗口 Playwright 后退出，
  退出码即验收结果。镜像内已预装 Chromium 运行所需系统库。
