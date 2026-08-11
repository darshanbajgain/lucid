/**
 * Decision Combiner — Lucid v1.1 (Off / Basic / Smart)
 *
 * Builds the BLUR / ALLOW decision from two signals, gated by mode:
 *
 *   1. Image classifier (on-device ONNX, **Smart only**) — per-class score
 *      [0, 1] thresholded in IMAGE_THRESHOLDS. Smart blurs all classes.
 *   2. User blocklist (user-curated hashtag / phrase list) — substring match
 *      on the platform-extracted caption. Runs in **Basic + Smart**.
 *
 * Mode gating:
 *   off    → neither signal (fully inert)
 *   basic  → blocklist only
 *   smart  → image + blocklist (superset of basic)
 *
 * Source classification (for the blur overlay label):
 *   'image'     — image fired (regardless of blocklist)
 *   'blocklist' — only the blocklist fired
 *   'none'      — neither fired (ALLOW)
 *
 * The heuristic text analyser was retired earlier — user-curated blocklist
 * terms replace it: every text-side blur is an explicit user choice.
 */

import type { ClassifierMode } from './strictness';
import type { NsfwClass, DecisionSource } from '../analyzers/worker/protocol';
import type { BlocklistMatch } from './blocklist';

export type { DecisionSource };

// ---------------------------------------------------------------------------
// Tunable thresholds
// ---------------------------------------------------------------------------

/**
 * Per-mode per-class minimum image-class probability that triggers blur.
 * Only Smart runs the image model — it blurs every class it detects
 * (explicit + gore + suggestive). Off and Basic have no entries (no image
 * inference).
 *
 * gore uses the same 0.55 as explicit: it's the most cleanly separated class
 * (val F1 0.93, P 0.92 / R 0.94) so mid-range scores are rare, and it's a
 * hard-blur category — a low threshold maximises recall on graphic violence
 * with minimal false-positive risk.
 */
export const IMAGE_THRESHOLDS: Record<ClassifierMode, Partial<Record<NsfwClass, number>>> = {
    off: {},
    basic: {},
    smart: {
        explicit: 0.55,
        gore: 0.55,
        suggestive: 0.70,
    },
};

/** Modes that load the on-device image classifier. Only Smart. */
export function modeUsesImage(mode: ClassifierMode): boolean {
    return mode === 'smart';
}

// ---------------------------------------------------------------------------
// Combined decision
// ---------------------------------------------------------------------------

export interface CombinedDecision {
    /** True if any signal fires under the active mode's thresholds. */
    fires: boolean;
    /** Which signal triggered the blur ('none' if no fire). */
    source: DecisionSource;
    /**
     * Headline string used for the blur overlay's category label.
     * - 'Sensitive content'  (image)
     * - 'Blocked term'       (blocklist)
     * - '' (empty)           (no fire)
     */
    label: string;
    /** Reasons surfaced in the verdict log; first entry also lines up with
     *  the overlay's source-specific summary. */
    reasons: string[];
    /** Score used by the session engine for L1/L2/L3 level mapping. */
    finalScore: number;
    /** Per-class image probabilities (passed through if image ran). */
    imageScores?: Record<NsfwClass, number> | null;
}

/**
 * Build the unified decision from image scores + blocklist match.
 *
 * @param imageScores    Per-class probs from offscreen NSFW inference, or
 *                       null if Stage 2 didn't run.
 * @param mode           The active classifier mode (controls image only).
 * @param blocklistMatch Result of running checkBlocklist on the caption.
 */
export function combineDecision(
    imageScores: Record<NsfwClass, number> | null,
    mode: ClassifierMode,
    blocklistMatch?: BlocklistMatch,
): CombinedDecision {
    const imageThresholds = IMAGE_THRESHOLDS[mode];

    // Blocklist runs in Basic + Smart, but NOT Off (Off is fully inert; Basic
    // is the keyword-only tier). Smart is a superset of Basic, so it runs the
    // blocklist too.
    const blocklistFires = mode !== 'off' && !!blocklistMatch?.fires;

    // Image thresholds only count when image actually ran AND mode opts in.
    let imageFires = false;
    let firingImageClass: NsfwClass | null = null;
    if (imageScores && modeUsesImage(mode)) {
        for (const cls of Object.keys(imageThresholds) as NsfwClass[]) {
            const min = imageThresholds[cls];
            if (min !== undefined && imageScores[cls] >= min) {
                imageFires = true;
                firingImageClass = cls;
                break;
            }
        }
    }

    // Image takes priority on label so the user sees the more specific
    // signal when both fire.
    let source: DecisionSource;
    let label: string;
    if (imageFires) {
        source = 'image';
        label = 'Sensitive content';
    } else if (blocklistFires) {
        source = 'blocklist';
        label = 'Blocked term';
    } else {
        source = 'none';
        label = '';
    }

    const fires = imageFires || blocklistFires;

    const reasons: string[] = [];
    if (imageFires && firingImageClass && imageScores) {
        const p = imageScores[firingImageClass];
        reasons.push(`${firingImageClass} (${(p * 100).toFixed(0)}%)`);
    }
    if (blocklistFires && blocklistMatch) {
        const head = blocklistMatch.matched.slice(0, 3).join(', ');
        const more = blocklistMatch.matched.length - 3;
        reasons.push(more > 0 ? `${head} +${more} more` : head);
    }

    // Session engine uses this for L1/L2/L3 mapping. Blocklist matches get
    // a fixed 0.65 (lands in L2). Image uses its top firing-class probability.
    const topImageScore = imageScores
        ? Math.max(imageScores.explicit, imageScores.suggestive)
        : 0;
    const blocklistScore = blocklistFires ? 0.65 : 0;
    const finalScore = fires ? Math.max(topImageScore, blocklistScore) : 0;

    return {
        fires,
        source,
        label,
        reasons,
        finalScore,
        imageScores: imageScores ?? null,
    };
}
