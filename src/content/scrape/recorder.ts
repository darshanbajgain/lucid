/**
 * Scrape-mode recorder — Sprint 4 dataset capture
 *
 * Sends scanned items to the offscreen-doc IDB store. The offscreen
 * doc does the actual fetch + base64 + IDB write under the extension
 * origin so we get a CORS-clean copy of the thumbnail bytes even when
 * the content script's origin can't reach the CDN.
 *
 * Active only when `chrome.storage.local.lucid_scrape_mode === true`.
 * Set from the SW console:
 *
 *   chrome.storage.local.set({ lucid_scrape_mode: true })
 *
 * Export from the offscreen-doc DevTools console:
 *
 *   await __lucidExportScrape()   ← downloads a .jsonl
 *   await __lucidScrapeStats()    ← logs count + size
 *   await __lucidScrapeClear({ confirm: true })
 */

import type { ScannedItem } from '../observer';
import type { ScrapeRecordPayload } from '../analyzers/worker/protocol';

const CAPTION_MAX = 500;
let nextRequestId = 0;

/** Per-tab dedup — observer can re-emit the same item on virtualisation. */
const seenIds = new Set<string>();
const SEEN_CAP = 2000;

function ageOutSeenIfNeeded(): void {
    if (seenIds.size <= SEEN_CAP) return;
    const first = seenIds.values().next().value;
    if (first !== undefined) seenIds.delete(first);
}

/**
 * Fire-and-forget. We deliberately don't block the observer thread on
 * the offscreen-doc round trip — if a record fails (e.g. CDN URL has
 * expired before the fetch lands), we just log and move on; scrape
 * sessions are best-effort by design.
 */
export function recordScrapeItem(item: ScannedItem): void {
    if (!item.thumbnail?.src) return;
    if (seenIds.has(item.id)) return;
    seenIds.add(item.id);
    ageOutSeenIfNeeded();

    const payload: ScrapeRecordPayload = {
        url: item.thumbnail.src,
        caption: (item.caption ?? '').slice(0, CAPTION_MAX),
        item_id: item.id,
        platform: item.platform,
        timestamp: Date.now(),
    };

    const id = `scrape-${++nextRequestId}-${Date.now()}`;

    void chrome.runtime.sendMessage({
        id,
        type: 'SCRAPE_RECORD',
        payload,
    }).then((resp: { error?: string; payload?: { ok: true; bytes: number } } | undefined) => {
        if (resp?.error) {
            console.warn('[Lucid:scrape] record failed', item.id.slice(0, 24), resp.error);
        } else if (resp?.payload?.ok) {
            // Keep the log tight — observer fires hundreds of times per scroll
            // session. One short line per success is plenty for debugging.
            console.log('[Lucid:scrape] +', resp.payload.bytes, 'bytes', item.id.slice(0, 24));
        }
    }).catch(err => {
        console.warn('[Lucid:scrape] sendMessage threw', (err as Error).message);
    });
}

const SCRAPE_FLAG_KEY = 'lucid_scrape_mode';
let scrapeModeCached = false;

export function isScrapeMode(): boolean {
    return scrapeModeCached;
}

export async function initScrapeMode(): Promise<void> {
    try {
        const r = await chrome.storage.local.get(SCRAPE_FLAG_KEY);
        scrapeModeCached = r[SCRAPE_FLAG_KEY] === true;
        if (scrapeModeCached) {
            console.log('[Lucid:scrape] ⚠️ SCRAPE MODE ACTIVE — blur disabled, items recorded to offscreen IDB');
        }
    } catch {
        scrapeModeCached = false;
    }

    chrome.storage.local.onChanged.addListener(changes => {
        if (!changes[SCRAPE_FLAG_KEY]) return;
        const next = changes[SCRAPE_FLAG_KEY].newValue === true;
        if (next !== scrapeModeCached) {
            scrapeModeCached = next;
            console.log(`[Lucid:scrape] mode → ${next ? 'ON (no blur)' : 'OFF (normal pipeline)'}`);
        }
    });
}
