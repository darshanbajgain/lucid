/**
 * Persistent Result Cache — Lucid v2.2 multimodal
 *
 * L2 cache layer. Stores the final post-pipeline verdict (after both text
 * and image stages complete) in chrome.storage.local keyed by post URL hash.
 * Survives SPA navigations and page reloads.
 *
 * architecture:
 * - L1 (hot):       In-memory Map in index.ts — instant, lost on navigation.
 * - L2 (persistent): This module — chrome.storage.local, survives across tabs/reloads.
 *
 * Key format: `rc_<DJB2 hash>` to avoid collision with `dailyLog_*` keys.
 * Entries older than 7 days are pruned on every write to prevent storage bloat.
 *
 * Version history:
 *   v1 — NSFWJS era (Porn + Hentai + Sexy summed)
 *   v2 — Sprint 3 (Marqo single-class, score [0, 1])
 *   v3 — Sprint 4 (Lucid 3-class, single safetyScore)
 *   v4 — v2.2 multimodal: per-stage scores (text + image) + label + source
 */

import { logger } from '../../utils/logger';
import { djb2Hash } from '../../utils/hash';
import type { NsfwClass, DecisionSource } from '../analyzers/worker/protocol';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The verdict shape stored in L2 cache (v4).
 * Includes both signals so future re-evaluation can recompute decisions
 * against tunable thresholds without re-running the model.
 */
export interface CachedVerdict {
    readonly score: number;
    readonly reasons: string[];
    readonly label?: string;
    readonly source?: DecisionSource;
    readonly imageScores?: Record<NsfwClass, number>;
}

export interface CachedResult extends CachedVerdict {
    /** Timestamp (ms) when this entry was written. */
    readonly cachedAt: number;
    /** Bumped when the cache shape or underlying model changes. */
    readonly version?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CACHE_PREFIX = 'rc_';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Bump when the cache shape changes or the model emits different score ranges
 * OR when the underlying extraction logic changes (so old cached entries
 * with broken captions get re-analyzed).
 *   v2 — Sprint 3 (Marqo single-class)
 *   v3 — Sprint 4 (Lucid 3-class single-signal)
 *   v4 — v2.2 (multimodal: text + image stored separately)
 *   v5 — v2.2.1 (IG caption extraction fixed)
 *   v6 — v2.2.3 (text path retired; cache shape lost textScore field)
 *   v7 — v1.1.0 model (retrained 3-class) — old image verdicts are stale
 *   v8 — v1.2.0 model (4-class, +gore)
 *   v9 — preprocessing fix (center crop instead of stretch) — scores changed
 */
const CACHE_VERSION = 9;

// ---------------------------------------------------------------------------
// Hash Helper
// ---------------------------------------------------------------------------

function hashKey(url: string): string {
    return `${CACHE_PREFIX}${djb2Hash(url)}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function getCachedResult(
    contentUrl: string
): Promise<CachedResult | null> {
    try {
        const key = hashKey(contentUrl);
        const result = await chrome.storage.local.get(key);
        const entry = result[key] as CachedResult | undefined;

        if (!entry) return null;

        // Version-skip pre-v4 entries — they have a different shape (no
        // textScore / imageScores / label / source) and would yield wrong
        // decisions when re-evaluated by the v2.2 multimodal scorer.
        if ((entry.version ?? 1) < CACHE_VERSION) {
            chrome.storage.local.remove(key).catch(() => {});
            return null;
        }

        // Expire stale entries on read
        if (Date.now() - entry.cachedAt > MAX_AGE_MS) {
            chrome.storage.local.remove(key).catch(() => {});
            return null;
        }

        return entry;
    } catch (e) {
        logger.warn('ResultCache: read failed', e);
        return null;
    }
}

export async function setCachedResult(
    contentUrl: string,
    verdict: CachedVerdict,
): Promise<void> {
    try {
        const key = hashKey(contentUrl);
        const entry: CachedResult = {
            ...verdict,
            cachedAt: Date.now(),
            version: CACHE_VERSION,
        };
        await chrome.storage.local.set({ [key]: entry });

        // Fire-and-forget prune
        pruneStaleEntries().catch(() => {});
    } catch (e) {
        logger.warn('ResultCache: write failed', e);
    }
}

/**
 * Evict L2 entries whose verdict is cheap to recompute — everything the
 * blocklist could have decided. Called when the user edits the blocklist
 * (adds/removes a term, toggles a category) so off-screen posts re-evaluate
 * against the new term list on next encounter instead of returning a stale
 * cached verdict. Covers both directions:
 *   - `source: 'blocklist'` — was blurred by a now-removed term
 *   - `source: 'none'` / undefined — was ALLOW, may now match a new term
 *
 * Image-sourced verdicts (`source: 'image'`) are KEPT — they're expensive
 * to recompute (700 ms inference) and independent of the blocklist.
 */
export async function evictRecomputableVerdicts(): Promise<void> {
    try {
        const allData = await chrome.storage.local.get(null);
        const keysToRemove = Object.keys(allData).filter((k) => {
            if (!k.startsWith(CACHE_PREFIX)) return false;
            return (allData[k] as CachedResult | undefined)?.source !== 'image';
        });
        if (keysToRemove.length > 0) {
            await chrome.storage.local.remove(keysToRemove);
            logger.debug(`ResultCache: evicted ${keysToRemove.length} recomputable entries`);
        }
    } catch (e) {
        logger.warn('ResultCache: eviction failed', e);
    }
}

// ---------------------------------------------------------------------------
// Pruning
// ---------------------------------------------------------------------------

async function pruneStaleEntries(): Promise<void> {
    try {
        const allData = await chrome.storage.local.get(null);
        const keysToRemove: string[] = [];
        const now = Date.now();

        for (const key of Object.keys(allData)) {
            if (!key.startsWith(CACHE_PREFIX)) continue;

            const entry = allData[key] as CachedResult | undefined;
            if (entry && now - entry.cachedAt > MAX_AGE_MS) {
                keysToRemove.push(key);
            }
        }

        if (keysToRemove.length > 0) {
            await chrome.storage.local.remove(keysToRemove);
            logger.debug(`ResultCache: pruned ${keysToRemove.length} stale entries`);
        }
    } catch (e) {
        logger.warn('ResultCache: prune failed', e);
    }
}
