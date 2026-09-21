import { describe, expect, it } from 'vitest';
import {
  appendCommand,
  applyAck,
  buildCommand,
  buildSnapshot,
  createIdleState,
  expire,
  isPagePresented,
  presenterReducer,
  resolveTarget,
  retryCommand,
  startSession,
  type PresenterState,
} from './presenter';
import type { Ack, Command, ProgramPage } from './types';

const pages: ProgramPage[] = [
  { id: 'p1', name: '星图一', decodeBroken: false },
  { id: 'p2', name: '星图二', decodeBroken: false },
  { id: 'p3', name: '坏图', decodeBroken: true },
];

function live(): PresenterState {
  return startSession(createIdleState(), 'session-A', pages, 1000);
}

function ok(seq: number, sessionId = 'session-A'): Ack {
  return { type: 'ACK', sessionId, seq, status: 'OK' };
}
function fail(seq: number): Ack {
  return { type: 'ACK', sessionId: 'session-A', seq, status: 'FAIL', reason: 'IMAGE_FAILED' };
}

describe('resolveTarget', () => {
  it('无当前页时 NEXT 落首页，PREV 为 null', () => {
    expect(resolveTarget(pages, null, 'NEXT')).toBe('p1');
    expect(resolveTarget(pages, null, 'PREV')).toBeNull();
  });

  it('边界处翻页返回 null（不产生空操作）', () => {
    expect(resolveTarget(pages, 'p3', 'NEXT')).toBeNull();
    expect(resolveTarget(pages, 'p1', 'PREV')).toBeNull();
    expect(resolveTarget([], null, 'NEXT')).toBeNull();
  });

  it('顺序翻页', () => {
    expect(resolveTarget(pages, 'p1', 'NEXT')).toBe('p2');
    expect(resolveTarget(pages, 'p2', 'PREV')).toBe('p1');
  });
});

describe('发送与序号', () => {
  it('序号从 1 开始且严格停等：上一条未终结不能发下一条（避免画面跳变）', () => {
    let s = live();
    const c1 = buildCommand(s, { kind: 'GOTO', pageId: 'p1' }, 1);
    expect(c1.command?.seq).toBe(1);
    s = c1.state;
    expect(s.confirmedPageId).toBeNull();
    expect(s.commands[0].status).toBe('PENDING');

    const c2 = buildCommand(s, { kind: 'GOTO', pageId: 'p2' }, 2);
    expect(c2.state).toBe(s); // 前一条未终结：停等，不能发下一条
    expect(c2.command).toBeNull();

    // 上一条确认后即可发 seq 2
    s = applyAck(s, ok(1), 2);
    const c2b = buildCommand(s, { kind: 'GOTO', pageId: 'p2' }, 3);
    expect(c2b.command?.seq).toBe(2);
  });

  it('匹配确认后才更新权威页', () => {
    let s = live();
    s = buildCommand(s, { kind: 'GOTO', pageId: 'p2' }, 1).state;
    expect(isPagePresented(s, 'p2')).toBe(false);
    s = applyAck(s, ok(1), 2);
    expect(s.confirmedPageId).toBe('p2');
    expect(s.lastAckSeq).toBe(1);
    expect(isPagePresented(s, 'p2')).toBe(true);
  });

  it('遮黑状态只在确认后改变；解除遮黑回到原页', () => {
    let s = live();
    s = buildCommand(s, { kind: 'GOTO', pageId: 'p1' }, 1).state;
    s = applyAck(s, ok(1), 2);
    s = buildCommand(s, { kind: 'SET_BLACKOUT', blackout: true }, 3).state;
    expect(s.confirmedBlackout).toBe(false); // 待确认中仍显示旧状态
    s = applyAck(s, ok(2), 4);
    expect(s.confirmedBlackout).toBe(true);
    expect(isPagePresented(s, 'p1')).toBe(false);
    // 解除遮黑命令的 pageId 仍是 p1
    const unmask = buildCommand(s, { kind: 'SET_BLACKOUT', blackout: false }, 5);
    expect(unmask.command?.pageId).toBe('p1');
  });

  it('与现状一致的遮黑命令是空操作，不占序号', () => {
    let s = live();
    const r = buildCommand(s, { kind: 'SET_BLACKOUT', blackout: false }, 1);
    expect(r.command).toBeNull();
    expect(r.state).toBe(s);
  });
});

describe('待确认 / 超时 / 重试', () => {
  it('超时显示未确认；重试沿用原序号', () => {
    let s = live();
    s = buildCommand(s, { kind: 'GOTO', pageId: 'p1' }, 1).state;
    s = expire(s, 1, 4100);
    expect(s.commands[0].status).toBe('UNCONFIRMED');

    const retried = retryCommand(s, 1, 5000);
    expect(retried.command?.seq).toBe(1);
    s = retried.state;
    expect(s.commands[0].status).toBe('PENDING');
  });

  it('确认到达后再“超时”无效', () => {
    let s = live();
    s = buildCommand(s, { kind: 'GOTO', pageId: 'p1' }, 1).state;
    s = applyAck(s, ok(1), 2);
    const after = expire(s, 1, 9999);
    expect(after).toBe(s);
    expect(s.commands[0].status).toBe('CONFIRMED');
  });

  it('未确认时迟到的确认仍可收敛（在未被新序号越过前）', () => {
    let s = live();
    s = buildCommand(s, { kind: 'GOTO', pageId: 'p1' }, 1).state;
    s = expire(s, 1, 4100);
    expect(s.commands[0].status).toBe('UNCONFIRMED');
    s = applyAck(s, ok(1), 6000);
    expect(s.commands[0].status).toBe('CONFIRMED');
    expect(s.confirmedPageId).toBe('p1');
  });
});

describe('迟到确认、重复确认、其他会话消息', () => {
  it('重复 ACK 不产生变化', () => {
    let s = live();
    s = buildCommand(s, { kind: 'GOTO', pageId: 'p1' }, 1).state;
    s = applyAck(s, ok(1), 2);
    const again = applyAck(s, ok(1), 3);
    expect(again).toBe(s);
  });

  it('其他会话的 ACK 被忽略', () => {
    let s = live();
    s = buildCommand(s, { kind: 'GOTO', pageId: 'p1' }, 1).state;
    const foreign = applyAck(s, ok(1, 'session-OTHER'), 2);
    expect(foreign).toBe(s);
    expect(s.commands[0].status).toBe('PENDING');
  });

  it('未知序号与乱序旧序号 ACK 被忽略，画面不回跳', () => {
    let s = live();
    s = buildCommand(s, { kind: 'GOTO', pageId: 'p1' }, 1).state;
    s = applyAck(s, ok(1), 2);
    s = buildCommand(s, { kind: 'GOTO', pageId: 'p2' }, 3).state;
    s = applyAck(s, ok(2), 4);
    // 旧 seq
    expect(applyAck(s, ok(1), 5)).toBe(s);
    // 跳跃 seq（缺少 3）
    expect(applyAck(s, ok(4), 5)).toBe(s);
    expect(s.confirmedPageId).toBe('p2');
  });
});

describe('图片呈现失败', () => {
  it('FAIL 推进序号但保持最后成功页不变，标记该项失败', () => {
    let s = live();
    s = buildCommand(s, { kind: 'GOTO', pageId: 'p1' }, 1).state;
    s = applyAck(s, ok(1), 2);
    s = buildCommand(s, { kind: 'GOTO', pageId: 'p3' }, 3).state;
    s = applyAck(s, fail(2), 4);
    expect(s.confirmedPageId).toBe('p1'); // 最后成功页不变
    expect(s.lastAckSeq).toBe(2);
    expect(s.commands[1].status).toBe('FAILED');
    // 序号已终结，可以继续发下一条
    const next = buildCommand(s, { kind: 'GOTO', pageId: 'p2' }, 5);
    expect(next.command?.seq).toBe(3);
  });
});

describe('冻结与快照', () => {
  it('开始放映冻结节目单：不属于冻结快照的页无法下发', () => {
    const s = live();
    const ghost: Command = {
      kind: 'GOTO',
      seq: 1,
      sessionId: 'session-A',
      pageId: 'new-page-not-in-frozen',
      blackout: false,
    };
    expect(appendCommand(s, ghost, 1)).toBe(s);
    // buildCommand 同样拒绝快照外的页
    expect(buildCommand(s, { kind: 'GOTO', pageId: 'new-page-not-in-frozen' }, 1).command).toBeNull();
  });

  it('快照包含最后已确认页、遮黑状态、lastSeq 与冻结节目单', () => {
    let s = live();
    s = buildCommand(s, { kind: 'GOTO', pageId: 'p2' }, 1).state;
    s = applyAck(s, ok(1), 2);
    s = buildCommand(s, { kind: 'SET_BLACKOUT', blackout: true }, 3).state;
    s = applyAck(s, ok(2), 4);
    const snap = buildSnapshot(s, 'req-1');
    expect(snap).toMatchObject({
      type: 'SNAPSHOT_RES',
      sessionId: 'session-A',
      reqId: 'req-1',
      pageId: 'p2',
      blackout: true,
      lastSeq: 2,
    });
    expect(snap!.pages).toHaveLength(3);
    expect(snap!.pages).not.toBe(s.pages);
  });

  it('结束放映后状态归零，编辑供下一会话', () => {
    let s = live();
    s = presenterReducer(s, { type: 'STOP' });
    expect(s.phase).toBe('IDLE');
    expect(s.commands).toEqual([]);
    expect(s.sessionId).toBe('');
  });
});
