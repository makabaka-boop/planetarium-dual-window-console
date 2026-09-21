// 观众窗运行时：纯状态机 + BroadcastChannel + IndexedDB 解码探测。

import {
  createOrphan,
  createRecovering,
  initialStep,
  onCommand,
  onRenderResult,
  onSnapshot,
  type RenderIntent,
  type ViewerState,
} from '../protocol/viewer';
import {
  createChannel,
  isChannelMessage,
  isCommand,
  isSnapshotRes,
  newSessionId,
  type ChannelMessage,
  type SnapshotReq,
} from '../protocol/types';
import { probeImageDecode } from '../lib/decode';
import { getImageBlob } from '../lib/idb';

const SNAPSHOT_RETRY_MS = 700;
const SNAPSHOT_MAX_ATTEMPTS = 30;
/** 恢复时窗最小展示时长：保证刷新后不会有一帧旧星图闪现。 */
const RECOVERY_GUARD_MS = 300;

export type ViewerListener = (state: ViewerState, brokenSnapshotPage: string | null) => void;

export class ViewerRuntime {
  private state: ViewerState;
  private channel: BroadcastChannel;
  private listeners = new Set<ViewerListener>();
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  /** 当前在飞的命令解码标识，防止旧解码结果覆盖新命令。 */
  private inFlight: { seq: number; pageId: string } | null = null;
  /** 快照页解码探测失败的页（权威页仍是它，但界面给出“图片呈现失败”标记）。 */
  private brokenSnapshotPage: string | null = null;
  /** 已收到、等待恢复守卫结束后提交的快照。 */
  private pendingLive: { state: ViewerState; intent: RenderIntent | null } | null = null;
  /** 恢复开始时间；即使快照秒回也至少停留在恢复屏 RECOVERY_GUARD_MS。 */
  private readonly recoveryStartedAt: number;
  private guardTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(sessionId: string | null) {
    this.recoveryStartedAt = Date.now();
    this.channel = createChannel();
    if (sessionId) {
      this.state = createRecovering(sessionId, newSessionId());
      const { out } = initialStep(this.state);
      if (out) this.channel.postMessage(out);
      this.scheduleSnapshotRetry();
    } else {
      this.state = createOrphan();
    }
    this.channel.onmessage = (ev: MessageEvent) => this.handle(ev.data);
  }

  getState(): ViewerState {
    return this.state;
  }

  subscribe(fn: ViewerListener): () => void {
    this.listeners.add(fn);
    fn(this.state, this.brokenSnapshotPage);
    return () => this.listeners.delete(fn);
  }

  destroy(): void {
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    if (this.guardTimer) clearTimeout(this.guardTimer);
    this.channel.close();
    this.listeners.clear();
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this.state, this.brokenSnapshotPage);
  }

  private post(msg: ChannelMessage): void {
    this.channel.postMessage(msg);
  }

  private commitLive(): void {
    const pending = this.pendingLive;
    this.pendingLive = null;
    if (!pending) return;
    this.state = pending.state;
    this.brokenSnapshotPage = null;
    this.emit();
    if (pending.intent) void this.runIntent(pending.intent);
  }

  private scheduleSnapshotRetry(): void {
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    this.snapshotTimer = setTimeout(() => {
      this.attempts += 1;
      if (this.state.phase !== 'RECOVERING') return;
      if (this.attempts >= SNAPSHOT_MAX_ATTEMPTS) return; // 保持“恢复中”，等待控制台在线
      const out: SnapshotReq = {
        type: 'SNAPSHOT_REQ',
        sessionId: this.state.sessionId,
        reqId: this.state.pendingReqId,
      };
      this.post(out);
      this.scheduleSnapshotRetry();
    }, SNAPSHOT_RETRY_MS);
  }

  private handle(data: unknown): void {
    if (!isChannelMessage(data)) return;
    const msg = data as ChannelMessage;

    if (isSnapshotRes(msg)) {
      const { state: next, intent } = onSnapshot(this.state, msg);
      if (next === this.state) return; // 会话/reqId 不匹配：旧应答，忽略
      if (this.snapshotTimer) {
        clearTimeout(this.snapshotTimer);
        this.snapshotTimer = null;
      }
      // 至少停留在恢复屏一个守卫时窗，杜绝刷新瞬间的旧画面闪烁。
      if (this.guardTimer) clearTimeout(this.guardTimer);
      const elapsed = Date.now() - this.recoveryStartedAt;
      const wait = Math.max(0, RECOVERY_GUARD_MS - elapsed);
      this.guardTimer = setTimeout(() => {
        this.guardTimer = null;
        if (this.state.phase !== 'RECOVERING') return;
        this.commitLive();
      }, wait);
      this.pendingLive = { state: next, intent };
      return;
    }

    // RECOVERING 阶段：命令与确认一律无效（旧命令、旧确认、其他会话消息）。
    if (this.state.phase !== 'LIVE') return;

    // LIVE 后自己的 SNAPSHOT_REQ 回声与 ACK 均忽略。
    if (!isCommand(msg)) return;

    const result = onCommand(this.state, msg);
    if (result.state === this.state && !result.out && !result.intent) return;
    this.state = result.state;
    if (result.out) this.post(result.out);
    this.emit();
    if (result.intent) void this.runIntent(result.intent);
  }

  private async runIntent(intent: RenderIntent): Promise<void> {
    if (intent.kind === 'SNAPSHOT') {
      const pageId = intent.pageId;
      if (!pageId) return;
      const blob = await getImageBlob(pageId).catch(() => undefined);
      if (!blob) {
        this.brokenSnapshotPage = pageId;
        this.emit();
        return;
      }
      const probe = await probeImageDecode(blob, 700);
      // 恢复后控制台可能已切走页：仅当它仍是当前权威页时标记。
      if (!probe.ok && this.state.pageId === pageId) {
        this.brokenSnapshotPage = pageId;
        this.emit();
      }
      return;
    }

    // COMMAND：预解码成功才提交，失败回 FAIL，最后成功页不变。
    this.inFlight = { seq: intent.seq, pageId: intent.pageId };
    const page = this.state.pages.find((p) => p.id === intent.pageId);
    let ok = !page?.decodeBroken;
    if (ok) {
      const blob = await getImageBlob(intent.pageId).catch(() => undefined);
      if (!blob) {
        ok = false;
      } else {
        const probe = await probeImageDecode(blob, 700);
        ok = probe.ok;
      }
    }
    // 被更新命令打断：本次探测结果作废。
    const stillCurrent =
      this.state.rendering?.seq === intent.seq &&
      this.state.rendering?.pageId === intent.pageId &&
      this.inFlight?.seq === intent.seq;
    if (!stillCurrent) return;
    this.inFlight = null;

    const { state: next, ack } = onRenderResult(
      this.state,
      intent.seq,
      intent.pageId,
      ok,
    );
    this.state = next;
    if (ack) this.post(ack);
    this.emit();
  }
}
