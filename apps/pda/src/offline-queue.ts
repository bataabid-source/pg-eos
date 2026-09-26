// WBS 2.16 part 1a-2 — offline queue (brief Master decisions 1, 2, 3).
//
// A minimal, dependency-free IndexedDB wrapper: one object store `queue` (db name
// `pda-offline-queue`), keyPath `id`, UUID keys via `crypto.randomUUID()`. No network/sync logic
// this part — the queue only grows via `enqueue`; a later slice wires the flush once a real
// scan/mutation endpoint exists.
//
// `subscribe(onChange)` is an in-memory `EventTarget`-based listener, fired after every successful
// IndexedDB write (enqueue) — hook-friendly, so `AppShell`'s badge can re-fetch `count()` on
// change without polling.
//
// `queueStatus(n)` is a pure function (doc 40 §D4 verbatim thresholds): no IndexedDB needed.

const DB_NAME = 'pda-offline-queue';
const DB_VERSION = 1;
const STORE_NAME = 'queue';

const QUEUE_STATUS_YELLOW_MAX = 20;

export interface QueueEntry {
  id: string;
  createdAt: string;
  payload: unknown;
}

const changeEmitter = new EventTarget();
const CHANGE_EVENT = 'change';

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// fix round 1, finding 3: `db.close()` must run even when the transaction rejects (readonly
// helpers below share this same try/finally + onabort shape — a transaction can `abort` (e.g.
// QuotaExceededError on write, or the connection being force-closed) without ever firing
// `onerror`, which would otherwise leave the returned promise pending forever).
export async function enqueue(payload: unknown): Promise<void> {
  const db = await openDatabase();
  const entry: QueueEntry = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    payload,
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).add(entry);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
    });
  } finally {
    db.close();
  }
  changeEmitter.dispatchEvent(new Event(CHANGE_EVENT));
}

export async function list(): Promise<QueueEntry[]> {
  const db = await openDatabase();
  try {
    return await new Promise<QueueEntry[]>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const request = transaction.objectStore(STORE_NAME).getAll();
      request.onsuccess = () => resolve(request.result as QueueEntry[]);
      request.onerror = () => reject(request.error);
      transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
    });
  } finally {
    db.close();
  }
}

export async function count(): Promise<number> {
  const db = await openDatabase();
  try {
    return await new Promise<number>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const request = transaction.objectStore(STORE_NAME).count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
    });
  } finally {
    db.close();
  }
}

export function subscribe(onChange: () => void): () => void {
  changeEmitter.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    changeEmitter.removeEventListener(CHANGE_EVENT, onChange);
  };
}

export function queueStatus(n: number): 'green' | 'yellow' | 'red' {
  if (n === 0) {
    return 'green';
  }
  if (n <= QUEUE_STATUS_YELLOW_MAX) {
    return 'yellow';
  }
  return 'red';
}
