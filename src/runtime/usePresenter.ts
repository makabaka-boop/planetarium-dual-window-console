// 控制台运行时：把纯协议状态机接到 BroadcastChannel 与定时器上。

import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import {
  buildCommand,
  buildSnapshot,
  presenterReducer,
  resolveTarget,
  retryCommand,
  startSession,
  type PresenterState,
} from '../protocol/presenter';
import {
  createChannel,
  isAck,
  isChannelMessage,
  isSnapshotReq,
  newSessionId,
  type ProgramPage,
} from '../protocol/types';

function ackTimeoutMs(): number {
  const override =
    typeof localStorage !== 'undefined'
      ? Number(localStorage.getItem('dome:ackTimeoutMs'))
      : NaN;
  return Number.isFinite(override) && override > 0 ? override : 4000;
}

export interface PresenterRuntime {
  state: PresenterState;
  start: (pages: ProgramPage[]) => void;
  stop: () => void;
  /** 尝试打开观众窗；被拦截时状态进入 POPUP_BLOCKED（会话保留）。 */
  openViewer: () => void;
  goto: (pageId: string) => void;
  step: (dir: 'NEXT' | 'PREV') => void;
  toggleBlackout: () => void;
  /** 重试沿用原序号。 */
  retry: (seq: number) => void;
}

export function usePresenter(): PresenterRuntime {
  const [state, dispatch] = useReducer(presenterReducer, undefined, () => ({
    phase: 'IDLE' as const,
    sessionId: '',
    pages: [],
    lastAckSeq: 0,
    confirmedPageId: null,
    confirmedBlackout: false,
    commands: [],
    popupStatus: 'CLOSED' as const,
  }));
  // stateRef 让异步回调与命令构造读到最新状态，而不必反复重订阅通道。
  const stateRef = useRef(state);
  stateRef.current = state;
  const channelRef = useRef<BroadcastChannel | null>(null);
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const post = useCallback((msg: unknown) => {
    channelRef.current?.postMessage(msg);
  }, []);

  const armTimeout = useCallback((seq: number) => {
    const old = timersRef.current.get(seq);
    if (old) clearTimeout(old);
    const timer = setTimeout(() => {
      timersRef.current.delete(seq);
      // 匹配确认前显示“待确认”；超时显示“未确认”。
      dispatch({ type: 'EXPIRE', seq, now: Date.now() });
    }, ackTimeoutMs());
    timersRef.current.set(seq, timer);
  }, []);

  useEffect(() => {
    const channel = createChannel();
    channelRef.current = channel;
    channel.onmessage = (ev: MessageEvent) => {
      if (!isChannelMessage(ev.data)) return;
      const msg = ev.data;
      const cur = stateRef.current;
      if (isAck(msg)) {
        // applyAck 会过滤迟到/重复/异会话确认；对可能终结该序号的确认先撤超时。
        const entry = cur.commands.find((c) => c.seq === msg.seq);
        if (entry && (entry.status === 'PENDING' || entry.status === 'UNCONFIRMED')) {
          const timer = timersRef.current.get(msg.seq);
          if (timer) {
            clearTimeout(timer);
            timersRef.current.delete(msg.seq);
          }
        }
        dispatch({ type: 'ACK', ack: msg, now: Date.now() });
        return;
      }
      if (isSnapshotReq(msg)) {
        // 恢复中的观众窗请求：只回应同会话请求（其他会话/旧会话忽略）。
        if (msg.sessionId === cur.sessionId) {
          const snapshot = buildSnapshot(cur, msg.reqId);
          if (snapshot) channel.postMessage(snapshot);
        }
      }
    };
    return () => {
      channel.close();
      channelRef.current = null;
      for (const t of timersRef.current.values()) clearTimeout(t);
      timersRef.current.clear();
    };
  }, []);

  const issue = useCallback(
    (spec: { kind: 'GOTO'; pageId: string } | { kind: 'SET_BLACKOUT'; blackout: boolean }) => {
      const { state: next, command } = buildCommand(stateRef.current, spec, Date.now());
      if (!command) return;
      stateRef.current = next;
      dispatch({ type: 'SEND', command, now: Date.now() });
      post(command);
      armTimeout(command.seq);
    },
    [armTimeout, post],
  );

  const start = useCallback((pages: ProgramPage[]) => {
    const sessionId = newSessionId();
    const next = startSession(stateRef.current, sessionId, pages, Date.now());
    stateRef.current = next;
    dispatch({ type: 'START', sessionId, pages, now: Date.now() });
    // 节目单自此冻结；随后的编辑只落库，供下一会话使用。
  }, []);

  const openViewer = useCallback(() => {
    const cur = stateRef.current;
    if (cur.phase !== 'LIVE') return;
    const url = `${window.location.origin}/viewer.html?sid=${encodeURIComponent(cur.sessionId)}`;
    // 窗口名带会话 ID：旧会话窗不会被复用成新会话窗。
    const win = window.open(url, `dome-viewer-${cur.sessionId}`);
    if (!win) {
      // 弹窗受阻：POPUP_BLOCKED，会话与命令全部保留。
      dispatch({ type: 'POPUP_STATUS', status: 'BLOCKED' });
      return;
    }
    void win;
    dispatch({ type: 'POPUP_STATUS', status: 'OPEN' });
  }, []);

  const stop = useCallback(() => {
    for (const t of timersRef.current.values()) clearTimeout(t);
    timersRef.current.clear();
    dispatch({ type: 'STOP' });
  }, []);

  const retry = useCallback(
    (seq: number) => {
      const { state: next, command } = retryCommand(stateRef.current, seq, Date.now());
      if (!command) return;
      stateRef.current = next;
      dispatch({ type: 'SEND', command, now: Date.now() });
      post(command);
      armTimeout(command.seq);
    },
    [armTimeout, post],
  );

  const goto = useCallback((pageId: string) => issue({ kind: 'GOTO', pageId }), [issue]);

  const step = useCallback(
    (dir: 'NEXT' | 'PREV') => {
      const cur = stateRef.current;
      const pageId = resolveTarget(cur.pages, cur.confirmedPageId, dir);
      if (pageId) issue({ kind: 'GOTO', pageId });
    },
    [issue],
  );

  const toggleBlackout = useCallback(() => {
    issue({ kind: 'SET_BLACKOUT', blackout: !stateRef.current.confirmedBlackout });
  }, [issue]);

  return useMemo(
    () => ({ state, start, stop, openViewer, goto, step, toggleBlackout, retry }),
    // state 每次 dispatch 都变化，保证 UI 跟随；其余引用稳定。
    [state, start, stop, openViewer, goto, step, toggleBlackout, retry],
  );
}
