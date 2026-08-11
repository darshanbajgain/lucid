/**
 * Cross-Thread Communication Protocol
 *
 * Defines the contract between the main thread (WorkerBridge) and the
 * Background Service Worker executing heavy analysis (YCrCb + NSFWJS).
 */

export interface VisionAnalysisResult {
    score: number;
    reasons: string[];
}

/** Class index is alphabetical, fixed by the training ImageFolder order. */
export type NsfwClass = 'explicit' | 'gore' | 'neutral' | 'suggestive';

/**
 * Which signal triggered the decision. Mirrors `engine/scorer.ts` but
 * lives here so the cache layer can reference it without circular imports.
 *   'image'     — on-device classifier crossed its threshold
 *   'blocklist' — user-curated hashtag/phrase list matched
 *   'none'      — ALLOW
 */
export type DecisionSource = 'image' | 'blocklist' | 'none';

export interface NSFWAnalysisResult {
    /**
     * Per-class softmax probabilities from the on-device classifier.
     * v1.2.0 (2026-08-03): 4-class fine-tuned Marqo backbone (+gore).
     * Sums to ~1.0. Class index mapping (alphabetical, fixed by the
     * training ImageFolder order): explicit=0, gore=1, neutral=2, suggestive=3.
     */
    scores: Record<NsfwClass, number>;
    /** argmax class — convenience, callers can recompute from `scores`. */
    predictedClass: NsfwClass;
    reasons: string[];
}

// ---------------------------------------------------------------------------
// YCrCb (legacy / thesis bias example)
// ---------------------------------------------------------------------------

export type WorkerMessageType = 'ANALYZE_VISION' | 'ANALYZE_NSFW' | 'PING';

export interface WorkerRequest {
    id: string;
    type: 'ANALYZE_VISION';
    payload: {
        pixels: Uint8ClampedArray;
        width: number;
        height: number;
    };
}

export interface WorkerResultMessage {
    id: string;
    type: 'ANALYZE_VISION_RESULT';
    payload?: VisionAnalysisResult;
    error?: string;
}

// ---------------------------------------------------------------------------
// NSFWJS (Phase B — primary NSFW signal)
// ---------------------------------------------------------------------------

export interface WorkerNSFWRequest {
    id: string;
    type: 'ANALYZE_NSFW';
    payload: {
        imageUrl: string; // Thumbnail src — BSW fetches it (not subject to page CSP)
    };
}

export interface WorkerNSFWResultMessage {
    id: string;
    type: 'ANALYZE_NSFW_RESULT';
    payload?: NSFWAnalysisResult;
    error?: string;
}

// ---------------------------------------------------------------------------
// Scrape mode (Sprint 4 dataset capture — `lucid_scrape_mode` storage flag)
// ---------------------------------------------------------------------------

export interface ScrapeRecordPayload {
    /** Thumbnail URL (signed CDN URL, may expire — that's why we base64 the bytes offscreen). */
    url: string;
    /** Truncated to ~500 chars in the recorder. */
    caption: string;
    /** Platform-side unique ID from observer.getUniqueId; used as dedup key. */
    item_id: string;
    /** Observer strategy name — 'Instagram' | 'YouTube'. */
    platform: string;
    /** Unix ms when the observer scanned the item. */
    timestamp: number;
}

export interface WorkerScrapeRequest {
    id: string;
    type: 'SCRAPE_RECORD';
    payload: ScrapeRecordPayload;
}

export interface WorkerScrapeResultMessage {
    id: string;
    type: 'SCRAPE_RECORD_RESULT';
    payload?: { ok: true; bytes: number };
    error?: string;
}

// ---------------------------------------------------------------------------
// Union types
// ---------------------------------------------------------------------------

export interface WorkerReadyMessage {
    type: 'READY';
}

export type AnyWorkerRequest =
    | WorkerRequest
    | WorkerNSFWRequest
    | WorkerScrapeRequest
    | { id?: string; type: 'PING' };

export type WorkerResponse =
    | WorkerReadyMessage
    | WorkerResultMessage
    | WorkerNSFWResultMessage
    | WorkerScrapeResultMessage;
