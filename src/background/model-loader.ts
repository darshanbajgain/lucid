/**
 * Model loader — CDN + Cache API (no bundled fallback).
 *
 * The ~22 MB ONNX classifier ships out-of-bundle from a public Hugging Face
 * model repo (darshan12222/lucid-nsfw-4class). On first inference we fetch it,
 * stash the response in the Cache API, and return the bytes. Every subsequent
 * inference — across tabs, restarts, even if Hugging Face later goes down —
 * hits the cache instantly.
 *
 * The bundled fallback was removed once the CDN path was proven (shrinks the
 * extension .zip by ~22 MB). The only risk window is a brand-new install whose
 * very first inference happens while the host is unreachable: that one load
 * throws (caught upstream → no image blur that scan; the keyword blocklist
 * still works), and it retries on the next scan. After one successful load the
 * model is cached for good.
 *
 * Cache invalidation: bump MODEL_CACHE_NAME (e.g. v3 → v4) when shipping a
 * new model. Old cache entries get GC'd by the browser; no manual cleanup.
 */

import { logger } from '../utils/logger';

// Hugging Face "resolve" URL → the raw file (302-redirects to the HF CDN, which
// serves it with CORS `*`). host_permissions cover huggingface.co + *.hf.co.
const MODEL_URL =
    'https://huggingface.co/darshan12222/lucid-nsfw-4class/resolve/main/lucid_nsfw_4class_fp32.onnx';

// Bumped v3 → v4 when the model moved from the GitHub release to Hugging Face.
// Old cached bytes under 'lucid-models-v3' are abandoned and GC'd by the browser.
const MODEL_CACHE_NAME = 'lucid-models-v4';

export async function loadModelBytes(): Promise<ArrayBuffer> {
    const cache = await caches.open(MODEL_CACHE_NAME);

    const cached = await cache.match(MODEL_URL);
    if (cached) {
        logger.debug('[NSFW] model: Cache API hit');
        return await cached.arrayBuffer();
    }

    logger.debug('[NSFW] model: downloading from CDN (~22 MB, one-time)');
    const t0 = performance.now();
    const response = await fetch(MODEL_URL);
    if (!response.ok) {
        throw new Error(`HTTP ${response.status} fetching ${MODEL_URL}`);
    }

    // .put() consumes the body — clone first so we can also read bytes here.
    await cache.put(MODEL_URL, response.clone());
    const bytes = await response.arrayBuffer();

    logger.debug(
        `[NSFW] model: CDN download complete (${Math.round(performance.now() - t0)} ms, ${(bytes.byteLength / 1_048_576).toFixed(1)} MB)`,
    );
    return bytes;
}
