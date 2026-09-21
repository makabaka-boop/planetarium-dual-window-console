import { useEffect, useMemo, useState } from 'react';
import { usePresenter } from './runtime/usePresenter';
import { useProgram } from './runtime/useProgram';
import { isPagePresented, resolveTarget } from './protocol/presenter';
import type { ProgramPage } from './protocol/types';
import './app.css';

const STATUS_TEXT: Record<string, string> = {
  PENDING: '待确认',
  UNCONFIRMED: '未确认',
  CONFIRMED: '已确认',
  FAILED: '呈现失败',
};

export default function App() {
  const presenter = usePresenter();
  const { state } = presenter;
  const frozen = state.phase === 'LIVE';
  const program = useProgram(frozen);
  const [startedAt] = useState(() => Date.now());

  // “开始放映即冻结”：快照当时的节目单进入协议，后续编辑仅落库供下一会话。
  const startShow = () => {
    const snapshot: ProgramPage[] = program.rows.map((r) => ({
      id: r.id,
      name: r.name,
      decodeBroken: r.decodeBroken,
    }));
    if (snapshot.length === 0) {
      alert('节目单为空，无法开始放映');
      return;
    }
    presenter.start(snapshot);
    void program.pruneForSession(snapshot);
  };

  useEffect(() => {
    document.title = '穹顶讲解 · 控制台';
  }, []);

  const currentIdx = useMemo(() => {
    if (!state.confirmedPageId) return -1;
    return state.pages.findIndex((p) => p.id === state.confirmedPageId);
  }, [state.confirmedPageId, state.pages]);

  const canNext = resolveTarget(state.pages, state.confirmedPageId, 'NEXT') !== null;
  const canPrev = resolveTarget(state.pages, state.confirmedPageId, 'PREV') !== null;
  const oldestPending = state.commands.find((c) => c.status === 'UNCONFIRMED');

  return (
    <div className="app" data-testid="console">
      <header className="topbar">
        <h1>穹顶讲解 · 讲解员控制台</h1>
        <div className="session">
          {frozen ? (
            <>
              <span className="badge badge-live" data-testid="phase">
                放映中（节目单已冻结）
              </span>
              <span className="sid" data-testid="session-id" title="会话 ID">
                会话 {state.sessionId.slice(0, 8)}
              </span>
              <button type="button" onClick={presenter.stop} data-testid="stop">
                结束放映
              </button>
            </>
          ) : (
            <span className="badge" data-testid="phase">
              编排中
            </span>
          )}
        </div>
      </header>

      <main className={frozen ? 'layout frozen' : 'layout'}>
        <section className="panel editor-panel">
          <div className="panel-head">
            <h2>节目单</h2>
            {frozen && <span className="frozen-note">已冻结，编辑将在下一会话生效</span>}
            {program.message && <span className="import-msg">{program.message}</span>}
          </div>

          {!frozen && (
            <label className="uploader" data-testid="uploader">
              <input
                type="file"
                accept="image/png,image/jpeg"
                multiple
                data-testid="file-input"
                onChange={(e) => {
                  if (e.target.files) void program.addFiles(e.target.files);
                  e.target.value = '';
                }}
              />
              <span>选择本地 PNG / JPEG（可多选；解码失败的单张仅标记该项）</span>
            </label>
          )}

          <ol className="page-list" data-testid="page-list">
            {program.rows.map((row, i) => {
              const presented = isPagePresented(state, row.id);
              return (
                <li
                  key={row.id}
                  className={`page-row ${row.decodeBroken ? 'broken' : ''} ${presented ? 'presented' : ''}`}
                  data-testid="page-row"
                  data-page-id={row.id}
                  data-presented={presented ? '1' : '0'}
                >
                  <span className="page-index">{i + 1}</span>
                  {frozen ? (
                    <span className="page-name">{row.name}</span>
                  ) : (
                    <input
                      className="page-name-input"
                      value={row.name}
                      onChange={(e) => program.rename(row.id, e.target.value)}
                    />
                  )}
                  {row.decodeBroken && <span className="tag tag-broken">解码失败</span>}
                  {presented && (
                    <span className="tag tag-presented" data-testid="presented-mark">
                      穹顶正在呈现
                    </span>
                  )}
                  <span className="row-actions">
                    <button
                      type="button"
                      disabled={frozen || i === 0}
                      onClick={() => program.move(row.id, -1)}
                    >
                      上移
                    </button>
                    <button
                      type="button"
                      disabled={frozen || i === program.rows.length - 1}
                      onClick={() => program.move(row.id, 1)}
                    >
                      下移
                    </button>
                    <button
                      type="button"
                      disabled={frozen}
                      onClick={() => program.remove(row.id)}
                    >
                      删除
                    </button>
                  </span>
                </li>
              );
            })}
            {program.rows.length === 0 && <li className="empty">尚未导入图片</li>}
          </ol>
        </section>

        <section className="panel control-panel">
          {!frozen ? (
            <div className="pre-show" data-testid="pre-show">
              <h2>编排完成后开始</h2>
              <p>共 {program.rows.length} 页</p>
              <button
                type="button"
                className="primary"
                onClick={startShow}
                disabled={program.status === 'importing' || program.rows.length === 0}
                data-testid="start"
              >
                开始放映
              </button>
            </div>
          ) : (
            <div className="show-controls" data-testid="show-controls">
              <div className="popup-status" data-testid="popup-status" data-status={state.popupStatus}>
                {state.popupStatus === 'BLOCKED' && (
                  <span className="blocked">
                    POPUP_BLOCKED — 浏览器拦截了观众窗，会话保留，请允许弹窗后重试
                  </span>
                )}
                {state.popupStatus === 'OPEN' && <span className="open">观众窗已打开</span>}
                {state.popupStatus === 'CLOSED' && <span>观众窗未打开</span>}
              </div>
              <button
                type="button"
                className="primary"
                onClick={presenter.openViewer}
                data-testid="open-viewer"
              >
                {state.popupStatus === 'BLOCKED' ? '重试打开观众窗' : '打开 / 重开观众窗'}
              </button>

              <div className="now-playing" data-testid="now-playing">
                <div className="np-label">穹顶权威画面</div>
                <div className="np-page">
                  {state.confirmedBlackout
                    ? '遮黑'
                    : currentIdx >= 0
                      ? `第 ${currentIdx + 1} / ${state.pages.length} 页 · ${state.pages[currentIdx].name}`
                      : '（尚未呈现）'}
                </div>
              </div>

              <div className="transport">
                <button type="button" onClick={() => presenter.step('PREV')} disabled={!canPrev} data-testid="prev">
                  ← 上页
                </button>
                <button
                  type="button"
                  className={state.confirmedBlackout ? 'warn' : ''}
                  onClick={presenter.toggleBlackout}
                  data-testid="blackout"
                  data-blackout={state.confirmedBlackout ? '1' : '0'}
                >
                  {state.confirmedBlackout ? '解除遮黑' : '遮黑'}
                </button>
                <button type="button" onClick={() => presenter.step('NEXT')} disabled={!canNext} data-testid="next">
                  下页 →
                </button>
              </div>

              <div className="jumper">
                <span>跳页：</span>
                {state.pages.map((p, i) => (
                  <button
                    key={p.id}
                    type="button"
                    className={`jump-btn ${p.id === state.confirmedPageId && !state.confirmedBlackout ? 'active' : ''} ${p.decodeBroken ? 'broken-btn' : ''}`}
                    onClick={() => presenter.goto(p.id)}
                    data-testid="jump"
                    data-page-id={p.id}
                    title={p.decodeBroken ? `${p.name}（解码失败，呈现将回失败）` : p.name}
                  >
                    {i + 1}
                  </button>
                ))}
              </div>

              <div className="log">
                <h3>命令与确认</h3>
                {oldestPending && (
                  <button
                    type="button"
                    className="retry-all"
                    onClick={() => presenter.retry(oldestPending.seq)}
                    data-testid="retry-oldest"
                  >
                    重试最早未确认（#{oldestPending.seq}，沿用原序号）
                  </button>
                )}
                <ul className="cmd-list" data-testid="cmd-list">
                  {[...state.commands].reverse().map((c) => {
                    const idx = state.pages.findIndex((p) => p.id === c.pageId);
                    return (
                      <li
                        key={c.seq}
                        className={`cmd cmd-${c.status.toLowerCase()}`}
                        data-testid="cmd-entry"
                        data-seq={c.seq}
                        data-status={c.status}
                      >
                        <span className="cmd-seq">#{c.seq}</span>
                        <span className="cmd-desc">
                          {c.kind === 'GOTO'
                            ? `跳至第 ${idx >= 0 ? idx + 1 : '?'} 页`
                            : c.blackout
                              ? '遮黑'
                              : '解除遮黑'}
                        </span>
                        <span className="cmd-status" data-testid="cmd-status">
                          {STATUS_TEXT[c.status]}
                        </span>
                        {(c.status === 'UNCONFIRMED' || c.status === 'FAILED') &&
                          c.seq === state.lastAckSeq + 1 &&
                          (c.status === 'UNCONFIRMED' ? (
                            <button
                              type="button"
                              className="cmd-retry"
                              onClick={() => presenter.retry(c.seq)}
                              data-testid="cmd-retry"
                            >
                              重试（同序号）
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="cmd-retry"
                              onClick={() =>
                                c.kind === 'SET_BLACKOUT'
                                  ? presenter.toggleBlackout()
                                  : presenter.goto(c.pageId)
                              }
                              data-testid="cmd-reissue"
                            >
                              重新下指令（新序号）
                            </button>
                          ))}
                      </li>
                    );
                  })}
                </ul>
              </div>
            </div>
          )}
        </section>
      </main>
      <span hidden data-testid="boot-ts">{startedAt}</span>
    </div>
  );
}
