// IndexedDB 持久层：图片 Blob 与节目单顺序分表存放，刷新可恢复。
// 纯前端，无后端、无外调。

import type { ProgramPage } from '../protocol/types';

const DB_NAME = 'dome-presenter';
const DB_VERSION = 1;
const STORE_IMAGES = 'images';
const STORE_KV = 'kv';
const KV_PROGRAM = 'program';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_IMAGES)) db.createObjectStore(STORE_IMAGES);
      if (!db.objectStoreNames.contains(STORE_KV)) db.createObjectStore(STORE_KV);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDB().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export async function saveImageBlob(id: string, blob: Blob): Promise<void> {
  await tx(STORE_IMAGES, 'readwrite', (s) => s.put(blob, id));
}

export async function getImageBlob(id: string): Promise<Blob | undefined> {
  return tx<Blob | undefined>(STORE_IMAGES, 'readonly', (s) => s.get(id));
}

export async function deleteImageBlob(id: string): Promise<void> {
  await tx(STORE_IMAGES, 'readwrite', (s) => s.delete(id));
}

export async function loadProgram(): Promise<ProgramPage[]> {
  const rows = await tx<ProgramPage[] | undefined>(STORE_KV, 'readonly', (s) => s.get(KV_PROGRAM));
  return rows ?? [];
}

export async function saveProgram(pages: ProgramPage[]): Promise<void> {
  await tx(STORE_KV, 'readwrite', (s) => s.put(pages, KV_PROGRAM));
}

/** 删除不再被节目单引用的 Blob。会话进行中不调用——仅新会话开始时清理。 */
export async function pruneUnusedImages(referencedIds: ReadonlySet<string>): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(STORE_IMAGES, 'readwrite');
    const store = t.objectStore(STORE_IMAGES);
    const req = store.getAllKeys();
    req.onsuccess = () => {
      for (const key of req.result) {
        if (!referencedIds.has(String(key))) store.delete(key);
      }
    };
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}
