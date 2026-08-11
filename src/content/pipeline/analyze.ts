/**
 * Pipeline Orchestrator — Lucid v2.2.3
 *
 * Two-stage progressive blur:
 *   Stage 1 (synchronous, ~1 ms) — user blocklist match on caption
 *   Stage 2 (async, ~700 ms)     — image classifier (Smart / Strict only)
 *   Decision combined via `engine/scorer.ts`
 *
 * Callers wire the two stages explicitly so the blur can be applied
 * immediately on Stage 1 fire (no 700 ms flash of the post) and then
 * upgraded / relabelled when Stage 2 completes.
 *
 * Sticky-blur invariant: once a blur is applied on Stage 1, Stage 2 may
 * confirm or relabel but NEVER unblur. This avoids the worse UX of blur
 * disappearing because the slower signal disagreed.
 *
 * No cloud calls. No heuristic text analysis — that path was retired
 * in v2.2.3 in favour of the user-controlled blocklist. To re-introduce
 * a text scoring layer in the future, add it in this file before the
 * combineDecision call.
 */

import type { ScannedItem } from '../observer';
import type { ClassifierMode } from '../engine/strictness';
import { loadStrictnessConfig } from '../engine/strictness';
import type { StrictnessConfig } from '../engine/strictness';
import type { CombinedDecision } from '../engine/scorer';
import { combineDecision, modeUsesImage } from '../engine/scorer';
import type { NsfwClass } from '../analyzers/worker/protocol';
import { classifyImage } from './on-device-classify';
import type { BlocklistMatch } from '../engine/blocklist';
import { loadBlocklistSettings, activeTerms, checkBlocklist } from '../engine/blocklist';

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** Result of the synchronous Stage 1 pass. */
export interface Stage1Result {
    decision: CombinedDecision;
    /** User blocklist match result. Re-passed to Stage 2's combineDecision
     *  so the same firing path stays stable across recombination. */
    blocklistMatch: BlocklistMatch;
}

/** Result of the full pipeline (Stage 1 + Stage 2 combined). */
export interface FullResult {
    decision: CombinedDecision;
    imageScores: Record<NsfwClass, number> | null;
    predictedClass: NsfwClass | null;
    mode: ClassifierMode;
}

// ---------------------------------------------------------------------------
// Config caching
// ---------------------------------------------------------------------------

let cachedConfig: StrictnessConfig | null = null;
let cachedBlocklistTerms: string[] | null = null;

chrome.storage.local.onChanged.addListener((changes) => {
    if (changes.lucid_classifier_mode || changes.lucid_strictness) {
        cachedConfig = null;
    }
    if (changes.lucid_blocklist) {
        cachedBlocklistTerms = null;
    }
});

export async function getMode(): Promise<ClassifierMode> {
    if (!cachedConfig) cachedConfig = await loadStrictnessConfig();
    return cachedConfig.mode;
}

export async function getBlocklistTerms(): Promise<string[]> {
    if (!cachedBlocklistTerms) {
        const settings = await loadBlocklistSettings();
        cachedBlocklistTerms = activeTerms(settings);
    }
    return cachedBlocklistTerms;
}

// ---------------------------------------------------------------------------
// Stage 1 — synchronous blocklist check
// ---------------------------------------------------------------------------

/**
 * Run Stage 1 synchronously. Image scores are intentionally null (Stage 2
 * hasn't run); the decision here is "would the blocklist alone fire?"
 *
 * Behaviour by mode:
 *   - off              → image stays off; blocklist can still fire
 *   - smart / strict   → provisional decision (Stage 2 will refine)
 */
export async function runStage1(item: ScannedItem, mode: ClassifierMode): Promise<Stage1Result> {
    const blocklistTerms = await getBlocklistTerms();
    const blocklistMatch = checkBlocklist(item.caption, blocklistTerms);
    const decision = combineDecision(null, mode, blocklistMatch);

    return { decision, blocklistMatch };
}

// ---------------------------------------------------------------------------
// Stage 2 — async image classifier (only if mode uses image)
// ---------------------------------------------------------------------------

/**
 * Run Stage 2 (image classifier) and combine with the Stage 1 result.
 *
 * Callers should only invoke this when `modeUsesImage(mode)` returns true.
 * For Off mode, the Stage 1 result IS the final result.
 */
export async function runStage2(
    item: ScannedItem,
    mode: ClassifierMode,
    stage1: Stage1Result,
): Promise<FullResult> {
    if (!modeUsesImage(mode)) {
        return {
            decision: stage1.decision,
            imageScores: null,
            predictedClass: null,
            mode,
        };
    }

    const imageResult = await classifyImage(item);
    const imageScores = imageResult?.scores ?? null;
    const predictedClass = imageResult?.predictedClass ?? null;

    // Recombine with the image result. Blocklist match is re-passed so its
    // firing path stays stable across recombination.
    const decision = combineDecision(imageScores, mode, stage1.blocklistMatch);

    return { decision, imageScores, predictedClass, mode };
}
