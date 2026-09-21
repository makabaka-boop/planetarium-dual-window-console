import { useEffect, useMemo, useRef, useState } from 'react';
import { ViewerRuntime } from './runtime/ViewerRuntime';
import { displayedPageBroken, type ViewerState } from './protocol/viewer';
import { getImageBlob } from './lib/idb';
import './viewer.css';

function sessionIdFromURL(): string | null {
  const params = new URLSearchParams(window.location.search);
  const sid = params.get('sid');
  return sid && sid.length > 0 ? sid : null;
}

export default function ViewerApp() {
  const [state, setState] = useState<ViewerState | null>(null);
  const [brokenSnapshotPage, setBrokenSnapshotPage] = useState<string | null>(null);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [imageError, setImageError] = useState(false);
  const runtimeRef = useRef<ViewerRuntime | null>(null);

  useEffect(() => {
    const runtime = new ViewerRuntime(sessionIdFromURL());
    runtimeRef.current = runtime;
    const unsub = runtime.subscribe((s, broken) => {
      setState({ ...s });
      setBrokenSnapshotPage(broken);
    });
    document.title = '穹顶';
    return () => {
      unsub();
      runtime.destroy();
    };
  }, []);

  // 权威页变化时从 IndexedDB 取 Blob 出图；只跟随“已提交”状态，解码中的中间态不展示。
  const pageId = state?.phase === 'LIVE' ? state.pageId : null;
  useEffect(() => {
    let revoked = false;
    let created: string | null = null;
    setImageError(false);
    if (!pageId) {
      setObjectUrl(null);
      return;
    }
    getImageBlob(pageId)
      .then((blob) => {
        if (revoked || !blob) {
          if (!blob) setImageError(true);
          return;
        }
        created = URL.createObjectURL(blob);
        setObjectUrl(created);
      })
      .catch(() => setImageError(true));
    return () => {
      revoked = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [pageId]);

  const broken = useMemo(() => {
    if (!state) return false;
    return displayedPageBroken(
      state,
      new Set(brokenSnapshotPage ? [brokenSnapshotPage] : []),
    );
  }, [state, brokenSnapshotPage]);

  if (!state || state.phase === 'ORPHAN') {
    return (
      <div className="dome orphan" data-testid="viewer" data-phase="ORPHAN">
        <p>观众窗需要由讲解员控制台打开。</p>
      </div>
    );
  }

  if (state.phase === 'RECOVERING') {
    // 恢复期间不显示任何旧画面，避免“跳回旧星图”。
    return (
      <div className="dome recovering" data-testid="viewer" data-phase="RECOVERING">
        <p className="recovery-text" data-testid="recovering">
          正在向控制台取得已确认画面快照…
        </p>
      </div>
    );
  }

  const showError = broken || imageError;
  return (
    <div
      className="dome live"
      data-testid="viewer"
      data-phase="LIVE"
      data-page-id={state.pageId ?? ''}
      data-blackout={state.blackout ? '1' : '0'}
    >
      {state.blackout ? (
        <div className="blackout-layer" data-testid="blackout-layer" />
      ) : state.pageId ? (
        showError ? (
          <div className="image-failed" data-testid="image-failed">
            <span>图片呈现失败</span>
          </div>
        ) : (
          objectUrl && (
            <img
              key={objectUrl}
              className="dome-image"
              src={objectUrl}
              alt="穹顶画面"
              data-testid="dome-image"
              onError={() => setImageError(true)}
            />
          )
        )
      ) : (
        <div className="no-page" data-testid="no-page">
          （尚无已呈现页）
        </div>
      )}
    </div>
  );
}
