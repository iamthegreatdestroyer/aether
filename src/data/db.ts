/**
 * Minimal IndexedDB wrapper — the only persistence layer in Tier A.
 *
 * No dependency (idb, dexie) on purpose: the app stores two things — an append-only forecast
 * log and a "latest snapshot per location" view — and forty lines cover both. The measured
 * footprint from the research holds here: a full 7-day hourly forecast is ~10 KB raw, so even
 * months of logging stays far under any browser quota.
 */

const DB_NAME = 'aether';
// v3, not v2, and the reason is a durable lesson: during development, HMR opened the DB at
// v2 in the window between "version bumped" and "store creation written", permanently
// consuming the upgrade event with only the old stores present. onupgradeneeded never
// re-fires at the same version, so any DB in that state is stuck. The handler below is
// contains()-guarded and therefore idempotent — bumping the version is always safe and is
// the correct recovery for exactly this situation.
const DB_VERSION = 3;

/** Append-only fetch-time forecast log. The verification ledger scores it at T+1 (P3). */
export const STORE_FORECAST_LOG = 'forecast_log';
/** Latest forecast per location — what a fresh offline boot renders from. */
export const STORE_LATEST = 'latest';
/** Captured observations — the truth side of the ledger. Keyed `${locationKey}|${isoHour}`. */
export const STORE_OBS = 'obs';
/** Scores — one per (entry, model, valid hour), keyed deterministically so rescoring is idempotent. */
export const STORE_SCORES = 'scores';

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      // Additive-only migrations: v1 stores are never touched, so P0-era receipts survive
      // every upgrade — an append-only ledger that loses history on migration is not one.
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_FORECAST_LOG)) {
        const log = db.createObjectStore(STORE_FORECAST_LOG, { autoIncrement: true });
        log.createIndex('by_location_time', ['locationKey', 'fetchedAt']);
      }
      if (!db.objectStoreNames.contains(STORE_LATEST)) {
        db.createObjectStore(STORE_LATEST);
      }
      if (!db.objectStoreNames.contains(STORE_OBS)) {
        const obs = db.createObjectStore(STORE_OBS);
        obs.createIndex('by_location', 'locationKey');
      }
      if (!db.objectStoreNames.contains(STORE_SCORES)) {
        const scores = db.createObjectStore(STORE_SCORES);
        scores.createIndex('by_location', 'locationKey');
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

export function dbGetAllByIndex<T>(
  store: string,
  index: string,
  key: IDBValidKey,
): Promise<T[]> {
  return tx(store, 'readonly', (s) => s.index(index).getAll(key) as IDBRequest<T[]>);
}

/** Entries WITH their keys — getAll() drops keys, and the scorer needs entry ids. */
export function dbEntries<T>(store: string): Promise<Array<{ key: IDBValidKey; value: T }>> {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const out: Array<{ key: IDBValidKey; value: T }> = [];
        const cur = db.transaction(store, 'readonly').objectStore(store).openCursor();
        cur.onsuccess = () => {
          const c = cur.result;
          if (c) {
            out.push({ key: c.key, value: c.value as T });
            c.continue();
          } else resolve(out);
        };
        cur.onerror = () => reject(cur.error ?? new Error('cursor failed'));
      }),
  );
}
