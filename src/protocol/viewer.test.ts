import { describe, expect, it } from 'vitest';
import {
  createOrphan,
  createRecovering,
  displayedPageBroken,
  initialStep,
  onCommand,
  onRenderResult,
  onSnapshot,
  type ViewerState,
} from './viewer';
import type {
  BlackoutCommand,
  GotoCommand,
  ProgramPage,
  SnapshotRes,
} from './types';

const pages: ProgramPage[] = [
  { id: 'p1', name: '一', decodeBroken: false },
  { id: 'p2', name: '二', decodeBroken: false },
  { id: 'bad', name: '坏', decodeBroken: true },
];

function snapshot(overrides: Partial<SnapshotRes> = {}): SnapshotRes {
  return {
    type: 'SNAPSHOT_RES',
    sessionId: 'S1',
    reqId: 'r1',
    pageId: 'p2',
    blackout: false,
    lastSeq: 3,
    pages,
    ...overrides,
  };
}

function goto(seq: number, pageId: string, sessionId = 'S1'): GotoCommand {
  return { kind: 'GOTO', seq, sessionId, pageId, blackout: false };
}
function blackout(seq: number, value: boolean, pageId = 'p2', sessionId = 'S1'): BlackoutCommand {
  return { kind: 'SET_BLACKOUT', seq, sessionId, blackout: value, pageId };
}

describe('启动与恢复', () => {
  it('带会话 ID 启动先请求快照，恢复期间不显示旧画面', () => {
    const s = createRecovering('S1', 'r1');
    expect(s.phase).toBe('RECOVERING');
    const { out } = initialStep(s);
    expect(out).toEqual({ type: 'SNAPSHOT_REQ', sessionId: 'S1', reqId: 'r1' });
    expect(s.pageId).toBeNull();
  });

  it('无会话 ID 为 ORPHAN', () => {
    expect(createOrphan().phase).toBe('ORPHAN');
  });

  it('只接受会话与 reqId 都匹配的快照；旧/异会话应答无效', () => {
    let s = createRecovering('S1', 'r1');
    expect(onSnapshot(s, snapshot({ sessionId: 'S2' })).state).toBe(s);
    expect(onSnapshot(s, snapshot({ reqId: 'old-req' })).state).toBe(s);

    const r = onSnapshot(s, snapshot());
    expect(r.state.phase).toBe('LIVE');
    expect(r.state.pageId).toBe('p2');
    expect(r.state.appliedSeq).toBe(3); // 已确认序号随快照恢复
    expect(r.state.blackout).toBe(false);
    s = r.state;

    // 已 LIVE 后再来的快照无效
    expect(onSnapshot(s, snapshot()).state).toBe(s);
  });

  it('恢复期间一切命令与确认都不生效', () => {
    const rec = createRecovering('S1', 'r1');
    // 直接把命令交给恢复中状态：无任何状态变化、无输出
    const r = onCommand(rec, goto(1, 'p1'));
    expect(r.state).toBe(rec);
    expect(r.out).toBeNull();
    expect(r.intent).toBeNull();
  });
});

describe('LIVE 命令序号规则', () => {
  function live(lastSeq = 0): ViewerState {
    return onSnapshot(createRecovering('S1', 'r1'), snapshot({ pageId: null, blackout: false, lastSeq })).state;
  }

  it('只接受 appliedSeq+1；更旧消息忽略', () => {
    let s = live(0);
    const older = onCommand(s, goto(0, 'p1'));
    expect(older.state).toBe(s);
    const gap = onCommand(s, goto(2, 'p2'));
    expect(gap.state).toBe(s);
  });

  it('切页先进入 rendering，解码成功才提交并 ACK OK', () => {
    let s = live(0);
    const r1 = onCommand(s, goto(1, 'p1'));
    expect(r1.out).toBeNull();
    expect(r1.state.rendering).toEqual({ seq: 1, pageId: 'p1' });
    expect(r1.state.pageId).toBeNull(); // 尚未呈现，不抢跳
    s = r1.state;

    const done = onRenderResult(s, 1, 'p1', true);
    expect(done.ack).toEqual({ type: 'ACK', sessionId: 'S1', seq: 1, status: 'OK' });
    expect(done.state.pageId).toBe('p1');
    expect(done.state.appliedSeq).toBe(1);
    expect(done.state.rendering).toBeNull();
  });

  it('图片解码失败回 FAIL，最后成功页不变，序号仍终结', () => {
    let s = live(0);
    s = onRenderResult(onCommand(s, goto(1, 'p1')).state, 1, 'p1', true).state;
    const r2 = onCommand(s, goto(2, 'bad'));
    s = r2.state;
    const failed = onRenderResult(s, 2, 'bad', false);
    expect(failed.ack).toMatchObject({ status: 'FAIL', reason: 'IMAGE_FAILED', seq: 2 });
    expect(failed.state.pageId).toBe('p1'); // 最后成功页不变
    expect(failed.state.appliedSeq).toBe(2);
  });

  it('导入时已坏的页在状态中可被标记', () => {
    const s: ViewerState = {
      phase: 'LIVE',
      sessionId: 'S1',
      pages,
      appliedSeq: 1,
      pageId: 'bad',
      blackout: false,
      pendingReqId: '',
      rendering: null,
    };
    expect(displayedPageBroken(s, new Set())).toBe(true);
    s.blackout = true;
    expect(displayedPageBroken(s, new Set())).toBe(false);
  });

  it('遮黑/解除遮黑无需解码，立即提交并确认', () => {
    let s = live(1);
    s = { ...s, pageId: 'p2' };
    const r = onCommand(s, blackout(2, true, 'p2'));
    expect(r.state.blackout).toBe(true);
    expect(r.state.appliedSeq).toBe(2);
    expect(r.out).toMatchObject({ status: 'OK', seq: 2 });
  });
});

describe('重复与重开', () => {
  it('已应用的重复命令只重发 ACK，不重复呈现（幂等）', () => {
    let s = onSnapshot(createRecovering('S1', 'r1'), snapshot({ pageId: 'p2', lastSeq: 3 })).state;
    // 重开/重发旧 seq 3
    const dup = onCommand(s, goto(3, 'p2'));
    expect(dup.state).toBe(s);
    expect(dup.out).toEqual({ type: 'ACK', sessionId: 'S1', seq: 3, status: 'OK' });
    expect(dup.intent).toBeNull();
  });

  it('解码中收到同一命令的重试：不重复呈现，稍后由解码结果确认', () => {
    let s = onSnapshot(createRecovering('S1', 'r1'), snapshot({ pageId: null, lastSeq: 0 })).state;
    s = onCommand(s, goto(1, 'p1')).state;
    const again = onCommand(s, goto(1, 'p1'));
    expect(again.state).toBe(s);
    expect(again.out).toBeNull();
  });

  it('重开后 lastSeq 生效：同序号重试幂等，下一条序号正确接续', () => {
    let s = onSnapshot(createRecovering('S1', 'r1'), snapshot({ pageId: 'p1', lastSeq: 2 })).state;
    // 控制台超时后重发 seq 2（重复）
    expect(onCommand(s, goto(2, 'p1')).out).toMatchObject({ seq: 2, status: 'OK' });
    // seq 3 正常处理
    const next = onCommand(s, goto(3, 'p2'));
    expect(next.state.rendering?.seq).toBe(3);
  });

  it('其他会话消息全部忽略', () => {
    const s = onSnapshot(createRecovering('S1', 'r1'), snapshot()).state;
    const r = onCommand(s, goto(4, 'p1', 'OTHER'));
    expect(r.state).toBe(s);
    expect(r.out).toBeNull();
  });

  it('过期解码结果不覆盖新命令', () => {
    let s = onSnapshot(createRecovering('S1', 'r1'), snapshot({ pageId: null, lastSeq: 0 })).state;
    s = onCommand(s, goto(1, 'p1')).state;
    // 被打断（这里模拟 seq2 抢占）；旧 seq1 结果作废
    s = { ...s, rendering: { seq: 2, pageId: 'p2' } };
    const stale = onRenderResult(s, 1, 'p1', true);
    expect(stale.state).toBe(s);
    expect(stale.ack).toBeNull();
  });
});
