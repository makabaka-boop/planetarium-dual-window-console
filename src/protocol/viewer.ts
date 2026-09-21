// 观众窗（穹顶）侧协议状态机——纯函数，便于 Vitest 核验。
//
// 关键不变量：
//  - RECOVERING：只接受匹配 reqId 的快照应答；旧命令、旧确认、其他会话消息一律无效。
//  - LIVE：只接受 appliedSeq+1 的命令；重复命令（同 seq）只重发 ACK，不重复呈现。
//  - 图片解码成功后才前移 appliedSeq；失败回 FAIL，最后成功页不变。
//  - 遮黑/解除遮黑无需解码，立即提交并确认。

import type {
  Ack,
  BlackoutCommand,
  Command,
  GotoCommand,
  ProgramPage,
  SnapshotReq,
  SnapshotRes,
} from './types';

export type ViewerPhase = 'ORPHAN' | 'RECOVERING' | 'LIVE';

/** 需要解码后提交的呈现意图。 */
export type RenderIntent =
  | { kind: 'SNAPSHOT'; pageId: string | null; reqId: string }
  | { kind: 'COMMAND'; pageId: string; seq: number };

export interface ViewerState {
  phase: ViewerPhase;
  sessionId: string;
  pages: readonly ProgramPage[];
  /** 已成功提交的最大序号（快照恢复不计入序号推进）。 */
  appliedSeq: number;
  /** 穹顶实际画面：最后成功页。 */
  pageId: string | null;
  blackout: boolean;
  /** 快照匹配 id；ORPHAN 为空。 */
  pendingReqId: string;
  /** 解码中的切页命令（期间重复/新命令按规则忽略，不抖动画面）。 */
  rendering: { seq: number; pageId: string } | null;
}

export interface StepResult {
  state: ViewerState;
  /** 需要回发的消息（ACK 或 SNAPSHOT_REQ）。 */
  out: Ack | SnapshotReq | null;
  /** 需要控制器异步探测解码的意图；null 表示无（已直接提交）。 */
  intent: RenderIntent | null;
}

export function createRecovering(sessionId: string, reqId: string): ViewerState {
  return {
    phase: 'RECOVERING',
    sessionId,
    pages: [],
    appliedSeq: 0,
    pageId: null,
    blackout: false,
    pendingReqId: reqId,
    rendering: null,
  };
}

/** URL 未带会话 ID（被直接打开，而非控制台弹出）。 */
export function createOrphan(): ViewerState {
  return {
    phase: 'ORPHAN',
    sessionId: '',
    pages: [],
    appliedSeq: 0,
    pageId: null,
    blackout: false,
    pendingReqId: '',
    rendering: null,
  };
}

/** 首条输出：进入恢复即请求完整快照。 */
export function initialStep(state: ViewerState): StepResult {
  if (state.phase !== 'RECOVERING') return { state, out: null, intent: null };
  return {
    state,
    out: { type: 'SNAPSHOT_REQ', sessionId: state.sessionId, reqId: state.pendingReqId },
    intent: null,
  };
}

/** 处理快照应答：会话与 reqId 必须同时匹配，恢复期间任何其他消息都无效。 */
export function onSnapshot(
  state: ViewerState,
  res: SnapshotRes,
): { state: ViewerState; intent: RenderIntent | null } {
  if (state.phase !== 'RECOVERING') return { state, intent: null };
  if (res.sessionId !== state.sessionId || res.reqId !== state.pendingReqId) {
    return { state, intent: null };
  }
  const next: ViewerState = {
    ...state,
    phase: 'LIVE',
    pages: res.pages,
    appliedSeq: res.lastSeq,
    pageId: res.pageId,
    blackout: res.blackout,
    pendingReqId: '',
  };
  // 快照页是权威画面，探测仅为把坏图标记到界面；失败不改变权威页。
  return {
    state: next,
    intent: res.pageId
      ? { kind: 'SNAPSHOT', pageId: res.pageId, reqId: res.reqId }
      : null,
  };
}

/** LIVE 状态下处理一条命令。 */
export function onCommand(state: ViewerState, command: Command): StepResult {
  if (state.phase !== 'LIVE') return { state, out: null, intent: null };
  if (command.sessionId !== state.sessionId) return { state, out: null, intent: null };

  // 重复命令（序号 == 已应用序号，控制台超时重试或重开后补发）：
  // 幂等重发 ACK，不重复呈现。必须先于“更旧”判断。
  if (command.seq === state.appliedSeq) {
    return {
      state,
      out: { type: 'ACK', sessionId: state.sessionId, seq: command.seq, status: 'OK' },
      intent: null,
    };
  }

  // 更旧且不重复的消息：忽略（它属于被终结的历史，不重发确认）。
  if (command.seq < state.appliedSeq + 1) return { state, out: null, intent: null };

  // 存在缺口（比期望的下一条更新）：忽略，等待旧命令重试。
  if (command.seq > state.appliedSeq + 1) return { state, out: null, intent: null };

  // 解码中：
  if (state.rendering) {
    if (state.rendering.seq === command.seq) {
      // 同一切页命令的重试：仍在解码，稍后由解码结果回 ACK，避免重复呈现。
      return { state, out: null, intent: null };
    }
    // 更新的命令打断解码：旧命令不再回 ACK，由新命令接管。
  }

  if (command.kind === 'SET_BLACKOUT') {
    const c = command as BlackoutCommand;
    const next: ViewerState = {
      ...state,
      appliedSeq: c.seq,
      pageId: c.pageId,
      blackout: c.blackout,
      rendering: null,
    };
    return {
      state: next,
      out: { type: 'ACK', sessionId: state.sessionId, seq: c.seq, status: 'OK' },
      intent: null,
    };
  }

  const c = command as GotoCommand;
  // 切页：先探测解码，成功后才提交（画面停留在最后成功页）。
  return {
    state: { ...state, rendering: { seq: c.seq, pageId: c.pageId } },
    out: null,
    intent: { kind: 'COMMAND', pageId: c.pageId, seq: c.seq },
  };
}

/** 命令切页探测结束：成功提交并 ACK OK；失败回 FAIL，appliedSeq 仍前移（该命令已终结）。 */
export function onRenderResult(
  state: ViewerState,
  seq: number,
  pageId: string,
  ok: boolean,
): { state: ViewerState; ack: Ack | null } {
  if (state.phase !== 'LIVE' || !state.rendering) return { state, ack: null };
  if (state.rendering.seq !== seq || state.rendering.pageId !== pageId) {
    return { state, ack: null }; // 已被更新的命令打断
  }
  if (ok) {
    return {
      state: {
        ...state,
        appliedSeq: seq,
        pageId,
        blackout: false,
        rendering: null,
      },
      ack: { type: 'ACK', sessionId: state.sessionId, seq, status: 'OK' },
    };
  }
  return {
    state: { ...state, appliedSeq: seq, rendering: null },
    ack: { type: 'ACK', sessionId: state.sessionId, seq, status: 'FAIL', reason: 'IMAGE_FAILED' },
  };
}

/** 当前是否为“图片实际无法呈现”的权威页（导入时已坏或快照探测失败）。 */
export function displayedPageBroken(
  state: ViewerState,
  brokenSnapshotPages: ReadonlySet<string>,
): boolean {
  if (state.phase !== 'LIVE' || state.blackout || !state.pageId) return false;
  if (brokenSnapshotPages.has(state.pageId)) return true;
  const page = state.pages.find((p) => p.id === state.pageId);
  return !!page?.decodeBroken;
}
