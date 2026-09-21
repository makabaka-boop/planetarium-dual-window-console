// 节目单数据：导入本地 PNG/JPEG、排序、保存到 IndexedDB；刷新可恢复。

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProgramPage } from '../protocol/types';
import {
  loadProgram,
  pruneUnusedImages,
  saveImageBlob,
  saveProgram,
} from '../lib/idb';
import { probeImageDecode } from '../lib/decode';

const ACCEPTED = new Set(['image/png', 'image/jpeg']);

export interface ProgramRow extends ProgramPage {
  size: number;
}

interface LoadedImage {
  id: string;
  blob: Blob;
  size: number;
  ok: boolean;
}

export type ImportState = 'idle' | 'importing';

export function useProgram(frozen: boolean) {
  const [rows, setRows] = useState<ProgramRow[]>([]);
  const [status, setStatus] = useState<ImportState>('idle');
  const [message, setMessage] = useState('');
  const [dirty, setDirty] = useState(false);
  // 冻结期间禁止从库中删除（会让正在放映的穹顶取不到图）。
  const frozenRef = useRef(frozen);
  frozenRef.current = frozen;

  useEffect(() => {
    let cancelled = false;
    loadProgram()
      .then((pages) => {
        if (cancelled) return;
        setRows(
          pages.map((p) => ({ id: p.id, name: p.name, decodeBroken: p.decodeBroken, size: 0 })),
        );
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const persist = useCallback(async (next: ProgramRow[]) => {
    await saveProgram(
      next.map(({ id, name, decodeBroken }) => ({ id, name, decodeBroken })),
    );
    setDirty(false);
  }, []);

  const addFiles = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files).filter(
        (f) => ACCEPTED.has(f.type) || /\.(png|jpe?g)$/i.test(f.name),
      );
      if (list.length === 0) return;
      setStatus('importing');
      setMessage(`正在导入 ${list.length} 张…`);
      const loaded: LoadedImage[] = [];
      for (const file of list) {
        const id =
          typeof crypto !== 'undefined' && 'randomUUID' in crypto
            ? crypto.randomUUID()
            : `p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        // 单张解码失败只标记该项，其余照常入库。
        // eslint-disable-next-line no-await-in-loop
        const probe = await probeImageDecode(file);
        // eslint-disable-next-line no-await-in-loop
        await saveImageBlob(id, file).catch(() => undefined);
        loaded.push({ id, blob: file, size: file.size, ok: probe.ok });
      }
      setRows((prev) => {
        const next = [
          ...prev,
          ...loaded.map((l, i) => ({
            id: l.id,
            name: list[i].name,
            decodeBroken: !l.ok,
            size: l.size,
          })),
        ];
        void persist(next);
        return next;
      });
      const broken = loaded.filter((l) => !l.ok).length;
      setMessage(
        broken > 0
          ? `已导入 ${loaded.length} 张，其中 ${broken} 张解码失败（已标记）`
          : `已导入 ${loaded.length} 张`,
      );
      setStatus('idle');
      setDirty(false);
    },
    [persist],
  );

  const remove = useCallback(
    (id: string) => {
      if (frozenRef.current) return; // 放映中：删除仅供下一会话，避免影响当前穹顶
      setRows((prev) => {
        const next = prev.filter((r) => r.id !== id);
        void persist(next);
        return next;
      });
    },
    [persist],
  );

  const move = useCallback(
    (id: string, dir: -1 | 1) => {
      if (frozenRef.current) return;
      setRows((prev) => {
        const idx = prev.findIndex((r) => r.id === id);
        const target = idx + dir;
        if (idx < 0 || target < 0 || target >= prev.length) return prev;
        const next = prev.slice();
        [next[idx], next[target]] = [next[target], next[idx]];
        setDirty(true);
        void persist(next);
        return next;
      });
    },
    [persist],
  );

  const rename = useCallback(
    (id: string, name: string) => {
      if (frozenRef.current) return;
      setRows((prev) => {
        const next = prev.map((r) => (r.id === id ? { ...r, name } : r));
        setDirty(true);
        void persist(next);
        return next;
      });
    },
    [persist],
  );

  /** 新会话开始：清理不再被冻结节目单引用的 Blob。 */
  const pruneForSession = useCallback(async (pages: readonly ProgramPage[]) => {
    await pruneUnusedImages(new Set(pages.map((p) => p.id))).catch(() => undefined);
  }, []);

  return { rows, status, message, dirty, addFiles, remove, move, rename, pruneForSession };
}
