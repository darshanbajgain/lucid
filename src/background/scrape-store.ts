/**
 * Scrape-mode storage — Sprint 4 dataset capture
 *
 * Runs inside the offscreen document so we share the same fetch +
 * host_permissions context as the NSFW classifier (Instagram's CDN
 * URLs need the extension origin to bypass page CSP). Records persist
 * across SW sleeps in the offscreen-doc's IndexedDB, scoped to the
 * extension origin.
 *
 *   chrome.runtime.sendMessage({ type: 'OFFSCREEN_SCRAPE_RECORD', payload })
 *     → fetch(url) → blob → base64
 *     → IDB.put({ key, url, caption, data_url, mime, bytes, ... })
 *
 *   await __lucidExportScrape()              ← downloads JSONL of all records
 *   await __lucidScrapeStats()               ← logs { count, mb, oldest, newest }
 *   await __lucidScrapeClear({ confirm: true })   ← drops the store
 *
 * Use from the offscreen-doc DevTools:
 *   chrome://extensions → Lucid → "Inspect views: offscreen.html"
 */

import type { ScrapeRecordPayload } from '../content/analyzers/worker/protocol';

const DB_NAME = 'lucid-scrape';
const DB_VERSION = 1;
const STORE = 'records';

interface ScrapeRow extends ScrapeRecordPayload {
    /** `${platform}-${item_id}` — primary key (dedup). */
    key: string;
    /** base64 data URL of the fetched thumbnail (no fixed size cap; export-time decision). */
    data_url: string;
    /** From the fetched blob — useful for the JSONL consumer. */
    mime: string;
    /** Decoded base64 byte count, for budgeting / stats. */
    bytes: number;
    /** Insertion timestamp on the offscreen side — separate from payload.timestamp (capture time). */
    stored_at: number;
}

// ---------------------------------------------------------------------------
// IndexedDB plumbing
// ---------------------------------------------------------------------------

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE)) {
                const store = db.createObjectStore(STORE, { keyPath: 'key' });
                store.createIndex('timestamp', 'timestamp', { unique: false });
                store.createIndex('platform', 'platform', { unique: false });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    }).catch(err => {
        dbPromise = null;
        throw err;
    });
    return dbPromise;
}

function putRecord(row: ScrapeRow): Promise<void> {
    return openDb().then(db => new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(row);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    }));
}

function hasKey(key: string): Promise<boolean> {
    return openDb().then(db => new Promise<boolean>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).getKey(key);
        req.onsuccess = () => resolve(req.result !== undefined);
        req.onerror = () => reject(req.error);
    }));
}

function allRecords(): Promise<ScrapeRow[]> {
    return openDb().then(db => new Promise<ScrapeRow[]>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).getAll();
        req.onsuccess = () => resolve(req.result as ScrapeRow[]);
        req.onerror = () => reject(req.error);
    }));
}

function clearStore(): Promise<void> {
    return openDb().then(db => new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    }));
}

// ---------------------------------------------------------------------------
// Capture — called from OFFSCREEN_SCRAPE_RECORD handler
// ---------------------------------------------------------------------------

function blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result as string);
        fr.onerror = () => reject(fr.error);
        fr.readAsDataURL(blob);
    });
}

export async function recordScrape(
    payload: ScrapeRecordPayload,
): Promise<{ ok: true; bytes: number; deduped?: true }> {
    const key = `${payload.platform}-${payload.item_id}`;

    if (await hasKey(key)) {
        return { ok: true, bytes: 0, deduped: true };
    }

    const resp = await fetch(payload.url, { mode: 'cors', credentials: 'omit' });
    if (!resp.ok) throw new Error(`fetch ${resp.status}`);
    const blob = await resp.blob();
    const data_url = await blobToDataUrl(blob);

    const row: ScrapeRow = {
        ...payload,
        key,
        data_url,
        mime: blob.type || 'application/octet-stream',
        bytes: blob.size,
        stored_at: Date.now(),
    };
    await putRecord(row);
    return { ok: true, bytes: blob.size };
}

// ---------------------------------------------------------------------------
// Export — JSONL download, called from the offscreen DevTools console
// ---------------------------------------------------------------------------

async function exportScrape(): Promise<{ count: number; mb: number; filename: string }> {
    const rows = await allRecords();
    if (rows.length === 0) {
        console.warn('[Lucid:scrape] no records to export');
        return { count: 0, mb: 0, filename: '' };
    }
    // JSONL — one record per line, easy for pandas/jq to consume.
    // Order by capture time so the export is roughly chronological.
    rows.sort((a, b) => a.timestamp - b.timestamp);

    const lines = rows.map(r => JSON.stringify(r));
    const blob = new Blob([lines.join('\n') + '\n'], { type: 'application/x-ndjson' });
    const mb = blob.size / (1024 * 1024);

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `lucid-scrape-${stamp}.jsonl`;

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    console.log('[Lucid:scrape] exported', { count: rows.length, mb: mb.toFixed(1), filename });
    return { count: rows.length, mb, filename };
}

async function scrapeStats(): Promise<{ count: number; mb: number; oldest: string | null; newest: string | null; perPlatform: Record<string, number> }> {
    const rows = await allRecords();
    const bytes = rows.reduce((s, r) => s + (r.bytes || 0), 0);
    const perPlatform: Record<string, number> = {};
    for (const r of rows) {
        perPlatform[r.platform] = (perPlatform[r.platform] ?? 0) + 1;
    }
    const ts = rows.map(r => r.timestamp).sort((a, b) => a - b);
    const stats = {
        count: rows.length,
        mb: bytes / (1024 * 1024),
        oldest: ts.length ? new Date(ts[0]).toISOString() : null,
        newest: ts.length ? new Date(ts[ts.length - 1]).toISOString() : null,
        perPlatform,
    };
    console.log('[Lucid:scrape] stats', stats);
    return stats;
}

async function clearScrape(opts: { confirm: boolean }): Promise<void> {
    if (!opts?.confirm) {
        console.warn('[Lucid:scrape] refused — call as __lucidScrapeClear({ confirm: true })');
        return;
    }
    await clearStore();
    console.log('[Lucid:scrape] store cleared');
}

// ---------------------------------------------------------------------------
// Expose to offscreen-doc DevTools
// ---------------------------------------------------------------------------

declare global {
    // eslint-disable-next-line no-var
    var __lucidExportScrape: typeof exportScrape | undefined;
    // eslint-disable-next-line no-var
    var __lucidScrapeStats: typeof scrapeStats | undefined;
    // eslint-disable-next-line no-var
    var __lucidScrapeClear: typeof clearScrape | undefined;
}

globalThis.__lucidExportScrape = exportScrape;
globalThis.__lucidScrapeStats = scrapeStats;
globalThis.__lucidScrapeClear = clearScrape;
