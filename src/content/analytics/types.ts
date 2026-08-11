/**
 * Analytics Types
 *
 * The atomic unit of research data. Each DailyLog captures one calendar day
 * of behavioral metrics. These are stored in chrome.storage.local with the
 * key format `dailyLog_YYYY-MM-DD`.
 *
 * This interface MUST be defined before any SessionEngine or Worker code —
 * without clean, structured data from day one, research results are unreliable.
 */

// Phase C — Intent Check-In (C2)
export type IntentValue = 'person' | 'topic' | 'quick' | 'browsing' | 'skip';

// Phase C — End-of-Session Mirror (C3)
export type AlignmentValue = 'yes' | 'no' | 'skip';

export interface DailyLog {
    /** ISO date string YYYY-MM-DD */
    readonly date: string;
    /** Total content items scanned by the pipeline */
    itemsScanned: number;
    /** Items that received a "block" decision */
    itemsBlocked: number;
    /** Items that received a "warn" decision */
    itemsWarned: number;
    /** Items that received an "allow" decision */
    itemsAllowed: number;
    /** Items where the user clicked "Reveal" */
    itemsRevealed: number;
    /** reveals / blocked — the #1 KPI for intervention calibration */
    revealRate: number;
    /** Reveals within 2s of blur — likely false positives */
    falsePositives: number;
    /** Cumulative scroll time in milliseconds for this day */
    totalScrollTimeMs: number;
    /** Number of distinct browsing sessions */
    sessionCount: number;
    /** Running average of pipeline inference time (ms) — Phase 2D telemetry */
    averageInferenceMs: number;
    /** Total pipeline runs used to compute the running average */
    totalInferences: number;
    // Phase C fields
    /** Session-start intent answer (C2) */
    intent: IntentValue | null;
    /** End-of-session alignment answer (C3) */
    intentAlignment: AlignmentValue | null;
    /** Number of thumbs-down personal tags recorded today (C4) */
    personalTagCount: number;
    // Phase G fields
    /** Number of Gemini API calls made today (G4) */
    geminiCallCount: number;
    /** Whether Research mode was active for any session today (G4) */
    geminiMode: boolean;
    /** Session mood string if user set one today (G5) */
    sessionMood: string | null;
}

/** Event types that the analytics engine can record */
export type AnalyticsEvent =
    | 'scanned'
    | 'blocked'
    | 'warned'
    | 'allowed';

/** Threshold in ms — reveals faster than this are likely false positives */
export const FALSE_POSITIVE_THRESHOLD_MS = 2000;
