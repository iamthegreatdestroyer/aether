/**
 * Minimal IndexedDB wrapper — the only persistence layer in Tier A.
 *
 * No dependency (idb, dexie) on purpose: the app stores two things — an append-only forecast
 * log and a "latest snapshot per location" view — and forty lines cover both. The measured
 * footprint from the research holds here: a full 7-day hourly forecast is ~10 KB raw, so even
 * months of logging stays far under any browser quota.
 */

const DB_NAME = 'aether';
const DB_VERSION = 1;

/** Append-only fetch-time forecast log. The verification ledger scores it at T+1 (P3). */
export const STORE_FORECAST_LOG = 'forecast_log';
/** Latest forecast per location — what a fresh offline boot renders from. */
export const STORE_LATEST = 'latest';

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_FORECAST_LOG)) {
        const log = db.createObjectStore(STORE_FORECAST_LOG, { autoIncrement: true });
        log.createIndex('by_location_time', ['locationKey', 'fetchedAt']);
      }
      if (!db.objectStoreNames.contains(STORE_LATEST)) {
        db.createObjectStore(STORE_LATEST);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
  });
  return dbPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = run(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error(`indexedDB ${mode} on ${store} failed`));
      }),
  );
}

export function dbAdd(store: string, value: unknown): Promise<IDBValidKey> {
  return tx(store, 'readwrite', (s) => s.add(value));
}

export function dbPut(store: string, value: unknown, key: IDBValidKey): Promise<IDBValidKey> {
  return tx(store, 'readwrite', (s) => s.put(value, key));
}

export function dbGet<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
  return tx(store, 'readonly', (s) => s.get(key) as IDBRequest<T | undefined>);
}

export function dbCount(store: string): Promise<number> {
  return tx(store, 'readonly', (s) => s.count());
}
