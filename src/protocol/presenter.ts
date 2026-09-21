// 控制台（讲解员）侧协议状态机——纯函数，便于 Vitest 核验。
//
// 关键不变量：
//  - 序号在会话内从 1 单调递增；只有“期望的下一条”确认才前移 lastAckSeq。
//  - 页/遮黑状态只在收到匹配确认后更新，因此控制台绝不会“误报尚未呈现的页”。
//  - 超时进入 UNCONFIRMED（未确认）；重试沿用原序号。
//  - 迟到的旧确认、重复确认一律忽略，画面不会跳回旧星图。

import type {
  Ack,
  BlackoutCommand,
  Command,
  GotoCommand,
  ProgramPage,
  SnapshotRes,
} from './types';

export type CommandStatus = 'PENDING' | 'UNCONFIRMED' | 'CONFIRMED' | 'FAILED';
export type PopupStatus = 'CLOSED' | 'OPEN' | 'BLOCKED';
export type Phase = 'IDLE' | 'LIVE';

export interface CommandEntry {
  seq: number;
  kind: Command['kind'];
  pageId: string;
  blackout: boolean;
  status: CommandStatus;
  sentAt: number;
  failReason?: 'IMAGE_FAILED';
}

export interface PresenterState {
  phase: Phase;
  sessionId: string;
  /** LIVE 期间为冻结节目单快照；IDLE 为空。 */
  pages: readonly ProgramPage[];
  /** 已收到确认的最大（且必须是连续的）序号；初始 0。 */
  lastAckSeq: number;
  /** 最后“已确认”的页——穹顶实际画面的权威记录。 */
  confirmedPageId: string | null;
  confirmedBlackout: boolean;
  commands: CommandEntry[];
  popupStatus: PopupStatus;
}

export type PresenterAction =
  | { type: 'START'; sessionId: string; pages: ProgramPage[]; now: number }
  | { type: 'STOP' }
  | { type: 'POPUP_STATUS'; status: PopupStatus }
  | { type: 'SEND'; command: Command; now: number }
  | { type: 'ACK'; ack: Ack; now: number }
  | { type: 'EXPIRE'; seq: number; now: number };

export function createIdleState(): PresenterState {
  return {
    phase: 'IDLE',
    sessionId: '',
    pages: [],
    lastAckSeq: 0,
    confirmedPageId: null,
    confirmedBlackout: false,
    commands: [],
    popupStatus: 'CLOSED',
  };
}

export function startSession(
  state: PresenterState,
  sessionId: string,
  pages: ProgramPage[],
  _now: number,
): PresenterState {
  if (state.phase === 'LIVE') return state;
  return {
    ...createIdleState(),
    phase: 'LIVE',
    sessionId,
    pages,
    popupStatus: 'CLOSED',
    commands: [],
  };
}

/** 翻页目标解析；无可翻页（已到边界或节目单为空）时返回 null（不产生空操作命令）。 */
export function resolveTarget(
  pages: readonly ProgramPage[],
  currentPageId: string | null,
  dir: 'NEXT' | 'PREV',
): string | null {
  if (pages.length === 0) return null;
  const idx = currentPageId ? pages.findIndex((p) => p.id === currentPageId) : -1;
  if (dir === 'NEXT') {
    if (idx === -1) return pages[0].id;
    return idx + 1 < pages.length ? pages[idx + 1].id : null;
  }
  // PREV：尚无当前页时不存在“上一页”。
  if (idx <= 0) return null;
  return pages[idx - 1].id;
}

export interface BuildResult {
  state: PresenterState;
  command: Command | null;
}

/**
 * 构造下一条命令（序号 = lastAckSeq + 1）。
 * blackout=true 遮黑；blackout=false 解除遮黑（展示当前/首页）。
 */
export function buildCommand(
  state: PresenterState,
  spec: { kind: 'GOTO'; pageId: string } | { kind: 'SET_BLACKOUT'; blackout: boolean },
  now: number,
): BuildResult {
  if (state.phase !== 'LIVE' || state.pages.length === 0) return { state, command: null };
  // 停等协议：期望序号上还有未终结（待确认/未确认）条目时不得发新命令。
  if (state.commands.some((c) => c.seq === state.lastAckSeq + 1)) {
    return { state, command: null };
  }

  let command: Command | null = null;
  if (spec.kind === 'GOTO') {
    if (!state.pages.some((p) => p.id === spec.pageId)) return { state, command: null };
    command = {
      kind: 'GOTO',
      seq: state.lastAckSeq + 1,
      sessionId: state.sessionId,
      pageId: spec.pageId,
      blackout: false,
    } satisfies GotoCommand;
  } else {
    // 遮黑不改变当前页；解除遮黑时若无已确认页则落在首页。
    const pageId = state.confirmedPageId ?? state.pages[0].id;
    if (spec.blackout === state.confirmedBlackout) {
      // 与现状一致的遮黑命令是空操作，不占用序号。
      return { state, command: null };
    }
    command = {
      kind: 'SET_BLACKOUT',
      seq: state.lastAckSeq + 1,
      sessionId: state.sessionId,
      blackout: spec.blackout,
      pageId,
    } satisfies BlackoutCommand;
  }

  return {
    state: appendCommand(state, command, now),
    command,
  };
}

/** 重试：仅“未确认”沿用原序号重发；FAILED 为终结态，需重新下指令（新序号）。 */
export function retryCommand(
  state: PresenterState,
  seq: number,
  now: number,
): { state: PresenterState; command: Command | null } {
  if (state.phase !== 'LIVE') return { state, command: null };
  const entry = state.commands.find((c) => c.seq === seq);
  if (!entry || entry.status !== 'UNCONFIRMED') {
    return { state, command: null };
  }
  // 只能重试“期望的下一条”；更旧的缺口由更旧条目先重试。
  if (seq !== state.lastAckSeq + 1) return { state, command: null };

  const base = { seq: entry.seq, sessionId: state.sessionId };
  const command: Command =
    entry.kind === 'GOTO'
      ? { kind: 'GOTO', ...base, pageId: entry.pageId, blackout: false }
      : { kind: 'SET_BLACKOUT', ...base, blackout: entry.blackout, pageId: entry.pageId };

  const commands = state.commands.map((c) =>
    c.seq === seq ? { ...c, status: 'PENDING' as const, sentAt: now } : c,
  );
  return { state: { ...state, commands }, command };
}

/** 追加一条已构造命令（序号必须恰好为 lastAckSeq+1，否则忽略，防止跳号）。 */
export function appendCommand(state: PresenterState, command: Command, now: number): PresenterState {
  if (state.phase !== 'LIVE') return state;
  if (command.sessionId !== state.sessionId) return state;
  if (command.seq !== state.lastAckSeq + 1) return state;
  if (state.commands.some((c) => c.seq === command.seq)) return state;
  // 冻结快照之外的页一律拒绝（放映中编辑新增的页仅供下一会话）。
  if (!state.pages.some((p) => p.id === command.pageId)) return state;
  const entry: CommandEntry = {
    seq: command.seq,
    kind: command.kind,
    pageId: command.pageId,
    blackout: command.blackout,
    status: 'PENDING',
    sentAt: now,
  };
  return { ...state, commands: [...state.commands, entry] };
}

/** 处理确认。返回新状态；迟到/重复/其他会话的确认不产生任何变化。 */
export function applyAck(state: PresenterState, ack: Ack, _now: number): PresenterState {
  if (state.phase !== 'LIVE') return state;
  if (ack.sessionId !== state.sessionId) return state;
  const entry = state.commands.find((c) => c.seq === ack.seq);
  if (!entry) return state;
  // 已终态确认（含重复 ACK）：忽略。
  if (entry.status === 'CONFIRMED' || entry.status === 'FAILED') return state;
  // 只接受“期望的下一条”。更旧的迟到确认无法再改变已收敛的状态。
  if (ack.seq !== state.lastAckSeq + 1) return state;

  if (ack.status === 'OK') {
    return {
      ...state,
      lastAckSeq: ack.seq,
      confirmedPageId: entry.pageId,
      confirmedBlackout: entry.blackout,
      commands: state.commands.map((c) => (c.seq === ack.seq ? { ...c, status: 'CONFIRMED' } : c)),
    };
  }
  // FAIL（图片呈现失败）：推进序号但保持“最后成功页”不变。
  return {
    ...state,
    lastAckSeq: ack.seq,
    commands: state.commands.map((c) =>
      c.seq === ack.seq ? { ...c, status: 'FAILED', failReason: 'IMAGE_FAILED' } : c,
    ),
  };
}

/** 超时：待确认 -> 未确认。 */
export function expire(state: PresenterState, seq: number, _now: number): PresenterState {
  const entry = state.commands.find((c) => c.seq === seq);
  if (!entry || entry.status !== 'PENDING') return state;
  return {
    ...state,
    commands: state.commands.map((c) =>
      c.seq === seq ? { ...c, status: 'UNCONFIRMED' } : c,
    ),
  };
}

export function presenterReducer(state: PresenterState, action: PresenterAction): PresenterState {
  switch (action.type) {
    case 'START':
      return startSession(state, action.sessionId, action.pages, action.now);
    case 'STOP':
      return createIdleState();
    case 'POPUP_STATUS':
      if (state.phase !== 'LIVE') return state;
      return { ...state, popupStatus: action.status };
    case 'SEND':
      return appendCommand(state, action.command, action.now);
    case 'ACK':
      return applyAck(state, action.ack, action.now);
    case 'EXPIRE':
      return expire(state, action.seq, action.now);
    default:
      return state;
  }
}

/** 为重开/刷新的观众窗构造“最后已确认页 + 遮黑状态 + 冻结节目单”完整快照。 */
export function buildSnapshot(
  state: PresenterState,
  reqId: string,
): SnapshotRes | null {
  if (state.phase !== 'LIVE') return null;
  return {
    type: 'SNAPSHOT_RES',
    sessionId: state.sessionId,
    reqId,
    pageId: state.confirmedPageId,
    blackout: state.confirmedBlackout,
    lastSeq: state.lastAckSeq,
    pages: state.pages.map((p) => ({ ...p })),
  };
}

/** 该页是否就是穹顶当前权威画面（未遮黑时）。 */
export function isPagePresented(state: PresenterState, pageId: string): boolean {
  return (
    state.phase === 'LIVE' &&
    !state.confirmedBlackout &&
    state.confirmedPageId === pageId
  );
}
