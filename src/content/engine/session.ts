/**
 * SessionEngine — Sprint 2 rewrite (three-level, score-driven)
 *
 * The pre-Sprint-2 engine escalated levels based on `consecutiveReveals`
 * and `sessionMinutes`. That penalised legitimate use (revealing the same
 * item twice was treated as worse than once) and was confusing to reason
 * about. v2 strips it down to:
 *
 *   1. Score-only level mapping (no reveal-count escalation)
 *   2. One time-based override: a 90-minute *daily cumulative* cooldown
 *      that forces every flagged item to L3 until midnight UTC
 *
 * Level table:
 *   | Level | Trigger                             | UI                           |
 *   | null  | score < 0.40                        | (no overlay — ALLOW)         |
 *   |   1   | 0.40 ≤ score < 0.70                 | 12 px blur · Reveal · Why?   |
 *   |   2   | 0.70 ≤ score < 0.90                 | 18 px blur · 3 s countdown   |
 *   |   3   | score ≥ 0.90 OR daily ≥ 90 min      | 24 px blur · cooldown · no Reveal |
 */

import { logger } from "../../utils/logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The 3 intervention levels. null = score below threshold, no overlay. */
export type InterventionLevel = 1 | 2 | 3;

/** Per-session in-memory state — counters reset when the browser closes. */
export interface SessionState {
    /** Timestamp (ms) of first content scan this session */
    sessionStartTime: number;
    /** All reveals this session — analytics only */
    totalReveals: number;
    /** Total block + warn decisions this session — analytics only */
    itemsBlurred: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SESSION_STORAGE_KEY = "lucid_session";
const DAILY_MIN_KEY_PREFIX = "lucid_feed_minutes_";

const SCORE_L1 = 0.40;
const SCORE_L2 = 0.70;
const SCORE_L3 = 0.90;

/** Daily cumulative minutes that triggers the L3 cooldown override. */
const DAILY_COOLDOWN_MINUTES = 90;

/** How often the engine ticks the daily-minutes counter. */
const MINUTE_TICK_MS = 60_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createFreshState(): SessionState {
    return {
        sessionStartTime: Date.now(),
        totalReveals: 0,
        itemsBlurred: 0,
    };
}

/** UTC date key — `YYYY-MM-DD`. Used so the 90-min limit resets at UTC midnight. */
function getUtcDateKey(): string {
    const now = new Date();
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, "0");
    const d = String(now.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
}

function dailyMinutesStorageKey(): string {
    return `${DAILY_MIN_KEY_PREFIX}${getUtcDateKey()}`;
}

function msUntilUtcMidnight(): number {
    const now = new Date();
    const tomorrow = new Date(Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() + 1,
        0, 0, 0, 0,
    ));
    return tomorrow.getTime() - now.getTime();
}

// ---------------------------------------------------------------------------
// SessionEngine
// ---------------------------------------------------------------------------

class SessionEngine {
    private state: SessionState = createFreshState();
    private dailyMinutesOnFeed = 0;
    private dailyKey = dailyMinutesStorageKey();
    private minuteTimer: ReturnType<typeof setInterval> | null = null;
    private initialized = false;

    // -----------------------------------------------------------------------
    // Initialisation
    // -----------------------------------------------------------------------

    async init(): Promise<void> {
        await this.loadSessionState();
        await this.loadDailyMinutes();
        this.startMinuteTicker();
        this.initialized = true;
    }

    private async loadSessionState(): Promise<void> {
        try {
            const result = await chrome.storage.session.get(SESSION_STORAGE_KEY);
            const persisted = result[SESSION_STORAGE_KEY] as SessionState | undefined;
            if (persisted && persisted.sessionStartTime) {
                this.state = persisted;
            } else {
                this.state = createFreshState();
                await chrome.storage.session.set({ [SESSION_STORAGE_KEY]: this.state });
            }
        } catch (e) {
            logger.warn("SessionEngine: session storage unavailable, using in-memory only", e);
        }
    }

    private async loadDailyMinutes(): Promise<void> {
        try {
            const r = await chrome.storage.local.get(this.dailyKey);
            const v = r[this.dailyKey];
            this.dailyMinutesOnFeed = typeof v === "number" ? v : 0;
        } catch (e) {
            logger.warn("SessionEngine: daily-minutes load failed, starting at 0", e);
        }
    }

    /**
     * Tick once per minute while the content script is alive. Each tick
     * increments today's cumulative-minutes counter and persists it.
     *
     * Multi-tab caveat: each open tab ticks independently, so total
     * minutes can over-count when the user has the feed open in 2+ tabs.
     * Acceptable for v2.0 — fix in v2.1 with a leader-election lock.
     */
    private startMinuteTicker(): void {
        if (this.minuteTimer) clearInterval(this.minuteTimer);
        this.minuteTimer = setInterval(() => {
            // Date may have rolled past UTC midnight — re-derive the key.
            const currentKey = dailyMinutesStorageKey();
            if (currentKey !== this.dailyKey) {
                this.dailyKey = currentKey;
                this.dailyMinutesOnFeed = 0;
            }
            this.dailyMinutesOnFeed += 1;
            chrome.storage.local
                .set({ [this.dailyKey]: this.dailyMinutesOnFeed })
                .catch((e) => logger.warn("SessionEngine: daily-minutes persist failed", e));
        }, MINUTE_TICK_MS);
    }

    // -----------------------------------------------------------------------
    // Core API
    // -----------------------------------------------------------------------

    /**
     * Score → InterventionLevel. Pure function of `score` and the daily
     * cumulative-minutes counter. No reveal-count escalation.
     */
    getLevel(score: number): InterventionLevel | null {
        if (score < SCORE_L1) return null; // ALLOW (even during cooldown)
        if (this.isInCooldown()) return 3;  // override flagged items to L3
        if (score >= SCORE_L3) return 3;
        if (score >= SCORE_L2) return 2;
        return 1;
    }

    recordBlur(): void {
        this.state.itemsBlurred++;
        this.persistSession();
    }

    recordReveal(): void {
        this.state.totalReveals++;
        this.persistSession();
    }

    /**
     * No-op in the new model — kept for callers that haven't been migrated.
     * The pre-Sprint-2 engine reset `consecutiveReveals` here; that field
     * no longer exists.
     */
    recordAllow(): void {
        // intentionally empty
    }

    getState(): Readonly<SessionState> & {
        sessionMinutes: number;
        dailyMinutesOnFeed: number;
    } {
        return {
            ...this.state,
            sessionMinutes: this.getSessionMinutes(),
            dailyMinutesOnFeed: this.dailyMinutesOnFeed,
        };
    }

    /** Ms until the daily cooldown lifts (midnight UTC), or 0 if not in cooldown. */
    getCooldownRemainingMs(): number {
        if (!this.isInCooldown()) return 0;
        return msUntilUtcMidnight();
    }

    isInCooldown(): boolean {
        return this.dailyMinutesOnFeed >= DAILY_COOLDOWN_MINUTES;
    }

    isInitialized(): boolean {
        return this.initialized;
    }

    // -----------------------------------------------------------------------
    // Internals
    // -----------------------------------------------------------------------

    private getSessionMinutes(): number {
        return (Date.now() - this.state.sessionStartTime) / 60_000;
    }

    private persistSession(): void {
        chrome.storage.session
            .set({ [SESSION_STORAGE_KEY]: this.state })
            .catch((e) => logger.warn("SessionEngine: session persist failed", e));
    }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const sessionEngine = new SessionEngine();
