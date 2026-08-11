import type { DailyLog, AnalyticsEvent, IntentValue, AlignmentValue } from './types';
import { FALSE_POSITIVE_THRESHOLD_MS } from './types';
import { logger } from '../../utils/logger';

/**
 * Analytics Engine
 *
 * Writes behavioral metrics to chrome.storage.local with daily rollover.
 * Key format: `dailyLog_YYYY-MM-DD`
 *
 * design:
 * - Singleton pattern — one engine per content script lifecycle.
 * - All writes are fire-and-forget (non-blocking).
 * - revealRate is recomputed on every reveal event.
 */

function getTodayKey(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `dailyLog_${year}-${month}-${day}`;
}

function getTodayDateString(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function createEmptyLog(date: string): DailyLog {
    return {
        date,
        itemsScanned: 0,
        itemsBlocked: 0,
        itemsWarned: 0,
        itemsAllowed: 0,
        itemsRevealed: 0,
        revealRate: 0,
        falsePositives: 0,
        totalScrollTimeMs: 0,
        sessionCount: 0,
        averageInferenceMs: 0,
        totalInferences: 0,
        intent: null,
        intentAlignment: null,
        personalTagCount: 0,
        geminiCallCount: 0,
        geminiMode: false,
        sessionMood: null,
    };
}

async function loadTodayLog(): Promise<DailyLog> {
    const key = getTodayKey();
    const result = await chrome.storage.local.get(key);
    const existing = result[key] as Partial<DailyLog> | undefined;

    if (existing) {
        // Migration: backfill fields added after initial schema.
        // Strip the deprecated `reflectionResponses` field if present from
        // pre-Sprint 2 entries — kept as runtime cleanup rather than typed.
        const { reflectionResponses: _drop, ...rest } = existing as Partial<DailyLog> & {
            reflectionResponses?: unknown;
        };
        void _drop;
        return {
            ...createEmptyLog(existing.date ?? getTodayDateString()),
            ...rest,
        };
    }

    // First access today — create a fresh log
    const fresh = createEmptyLog(getTodayDateString());
    await chrome.storage.local.set({ [key]: fresh });
    return fresh;
}

const MAX_LOG_AGE_DAYS = 90;

async function pruneOldLogs(): Promise<void> {
    try {
        const allData = await chrome.storage.local.get(null);
        const keysToRemove: string[] = [];
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - MAX_LOG_AGE_DAYS);
        const cutoffTime = cutoffDate.getTime();

        for (const key of Object.keys(allData)) {
            if (key.startsWith('dailyLog_')) {
                const dateStr = key.replace('dailyLog_', '');
                const logDate = new Date(dateStr).getTime();
                if (logDate < cutoffTime) {
                    keysToRemove.push(key);
                }
            }
        }

        if (keysToRemove.length > 0) {
            await chrome.storage.local.remove(keysToRemove);
            logger.debug(`Pruned ${keysToRemove.length} old analytics logs`);
        }
    } catch (e: any) {
        if (e && e.message && e.message.includes('Extension context invalidated')) return;
        logger.error('Failed to prune old logs:', e);
    }
}

async function saveTodayLog(log: DailyLog): Promise<void> {
    const key = getTodayKey();
    await chrome.storage.local.set({ [key]: log });
    // Fire-and-forget prune to prevent 10MB storage limit exhaustion
    pruneOldLogs().catch(() => {});
}

/**
 * Record a pipeline event (scanned, blocked, warned, allowed, revealed).
 * Fire-and-forget — errors are logged but never thrown.
 */
export async function record(event: AnalyticsEvent): Promise<void> {
    try {
        const log = await loadTodayLog();
        const updated = { ...log };

        switch (event) {
            case 'scanned':
                updated.itemsScanned++;
                break;
            case 'blocked':
                updated.itemsBlocked++;
                break;
            case 'warned':
                updated.itemsWarned++;
                break;
            case 'allowed':
                updated.itemsAllowed++;
                break;
        }

        // Recompute reveal rate after every change
        if (updated.itemsBlocked > 0) {
            updated.revealRate = updated.itemsRevealed / updated.itemsBlocked;
        }

        await saveTodayLog(updated);
    } catch (e: any) {
        if (e && e.message && e.message.includes('Extension context invalidated')) return;
        logger.error('Analytics record failed:', e);
    }
}

/**
 * Record a reveal event with latency tracking for false positive detection.
 * If the user reveals within FALSE_POSITIVE_THRESHOLD_MS of the blur being
 * applied, it's counted as a likely false positive.
 */
export async function recordReveal(revealLatencyMs: number): Promise<void> {
    try {
        const log = await loadTodayLog();
        const updated = { ...log };

        updated.itemsRevealed++;

        if (revealLatencyMs < FALSE_POSITIVE_THRESHOLD_MS) {
            updated.falsePositives++;
        }

        if (updated.itemsBlocked > 0) {
            updated.revealRate = updated.itemsRevealed / updated.itemsBlocked;
        }

        await saveTodayLog(updated);
        logger.debug('Reveal recorded', { latencyMs: revealLatencyMs, isFalsePositive: revealLatencyMs < FALSE_POSITIVE_THRESHOLD_MS });
    } catch (e: any) {
        if (e && e.message && e.message.includes('Extension context invalidated')) return;
        logger.error('Analytics recordReveal failed:', e);
    }
}

/**
 * Record pipeline inference duration for performance/battery telemetry.
 * Computes a running average to avoid storing per-item arrays.
 */
export async function recordInference(durationMs: number): Promise<void> {
    try {
        const log = await loadTodayLog();
        const updated = { ...log };

        const prevTotal = updated.totalInferences;
        const prevAvg = updated.averageInferenceMs;

        updated.totalInferences = prevTotal + 1;
        // Incremental mean: newAvg = prevAvg + (newValue - prevAvg) / newCount
        updated.averageInferenceMs =
            prevAvg + (durationMs - prevAvg) / updated.totalInferences;

        await saveTodayLog(updated);
    } catch (e: any) {
        if (e && e.message && e.message.includes('Extension context invalidated')) return;
        logger.error('Analytics recordInference failed:', e);
    }
}

// ---------------------------------------------------------------------------
// Phase C additions
// ---------------------------------------------------------------------------

export async function recordIntent(intent: IntentValue): Promise<void> {
    try {
        const log = await loadTodayLog();
        await saveTodayLog({ ...log, intent });
    } catch (e: any) {
        if (e?.message?.includes('Extension context invalidated')) return;
        logger.error('Analytics recordIntent failed:', e);
    }
}

export async function recordAlignment(alignment: AlignmentValue): Promise<void> {
    try {
        const log = await loadTodayLog();
        await saveTodayLog({ ...log, intentAlignment: alignment });
    } catch (e: any) {
        if (e?.message?.includes('Extension context invalidated')) return;
        logger.error('Analytics recordAlignment failed:', e);
    }
}

export async function recordPersonalTag(): Promise<void> {
    try {
        const log = await loadTodayLog();
        await saveTodayLog({ ...log, personalTagCount: (log.personalTagCount ?? 0) + 1 });
    } catch (e: any) {
        if (e?.message?.includes('Extension context invalidated')) return;
        logger.error('Analytics recordPersonalTag failed:', e);
    }
}

// ---------------------------------------------------------------------------
// Phase G additions
// ---------------------------------------------------------------------------

export async function recordGeminiCall(): Promise<void> {
    try {
        const log = await loadTodayLog();
        await saveTodayLog({
            ...log,
            geminiCallCount: (log.geminiCallCount ?? 0) + 1,
            geminiMode: true,
        });
    } catch (e: any) {
        if (e?.message?.includes('Extension context invalidated')) return;
        logger.error('Analytics recordGeminiCall failed:', e);
    }
}

export async function recordMood(mood: string): Promise<void> {
    try {
        const log = await loadTodayLog();
        await saveTodayLog({ ...log, sessionMood: mood.slice(0, 60) });
    } catch (e: any) {
        if (e?.message?.includes('Extension context invalidated')) return;
        logger.error('Analytics recordMood failed:', e);
    }
}
