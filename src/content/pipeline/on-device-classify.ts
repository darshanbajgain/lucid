/**
 * On-device image classifier wrapper — Lucid v2.2 multimodal pipeline (Stage 2)
 *
 * Thin async wrapper around the offscreen-document inference call. Returns
 * the per-class probabilities. **Does NOT apply thresholds or make the
 * blur decision** — that's the scorer's job (`engine/scorer.ts`) now that
 * we combine text + image signals.
 *
 * Called only in modes that load the image model:
 *   - smart   → text + image, image model loaded
 *   - strict  → text + image, image model loaded
 *
 * Light + Off skip this entirely (lazy-load win: image model never downloads
 * for Light-mode users, which is the default).
 */

import type { ScannedItem } from '../observer';
import type { NsfwClass } from '../analyzers/worker/protocol';
import { workerBridge } from '../analyzers/worker';

export interface ImageInferenceResult {
    /** Per-class softmax probabilities. */
    scores: Record<NsfwClass, number>;
    /** argmax class — convenience, callers can recompute from `scores`. */
    predictedClass: NsfwClass;
    /** Provider tag for the verdict log. */
    provider: 'lucid-3class' | 'none';
    /** Reasons surfaced by the model (e.g. "explicit (85%)"). */
    reasons: string[];
}

/**
 * Run the offscreen-document image classifier on the item's thumbnail.
 * Returns `null` if the item lacks a thumbnail or the inference call failed —
 * callers should treat null as "image signal unavailable" rather than ALLOW.
 */
export async function classifyImage(item: ScannedItem): Promise<ImageInferenceResult | null> {
    if (!item.thumbnail?.src) return null;

    try {
        const nsfw = await workerBridge.analyzeNSFW(item.thumbnail.src);
        return {
            scores: nsfw.scores,
            predictedClass: nsfw.predictedClass,
            provider: 'lucid-3class',
            reasons: nsfw.reasons,
        };
    } catch {
        return null;
    }
}
