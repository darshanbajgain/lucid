/**
 * Lucid Offscreen Document — On-device classifier
 *
 * Runs inside a DOM renderer process (chrome.offscreen API). Sprint 3
 * (2026-05-11) replaced NSFWJS / TF.js with Marqo `nsfw-image-detection-384`
 * via `onnxruntime-web`. See [`docs/SPRINT_3_PLAN.md`](../../docs/SPRINT_3_PLAN.md)
 * for the spike that locked in this choice.
 *
 * Model spec (Marqo vit-tiny @ 384):
 *   - Input: pixel_values [1, 3, 384, 384] float32, ImageNet normalisation
 *   - Output: logits [1, 2]; softmax → probs[0] = NSFW, probs[1] = SFW
 *   - Class index swap: Marqo's model card claims 0=SFW, 1=NSFW but the
 *     trained head uses alphabetical class order (N < S). Empirically
 *     confirmed during the initial conversion spike.
 *
 * The Background Service Worker (index.ts) creates this document on demand
 * and forwards ANALYZE_NSFW requests. The result shape is unchanged from
 * the NSFWJS era (`{ safetyScore, reasons }`) so the downstream pipeline
 * keeps working; only the numeric range narrows from [0, 3] (sum of three
 * class probs) to [0, 1] (single NSFW probability).
 */

import * as ort from 'onnxruntime-web';
import type { NSFWAnalysisResult, NsfwClass, ScrapeRecordPayload } from '../content/analyzers/worker/protocol';
import { recordScrape } from './scrape-store';
import { loadModelBytes } from './model-loader';
import { logger } from '../utils/logger';

const MODEL_INPUT_SIZE = 384;
// Short-side resize target before the center crop — mirrors the notebook's
// eval transform: Resize(INPUT_SIZE + 32) → CenterCrop(INPUT_SIZE).
const RESIZE_SHORT_SIDE = MODEL_INPUT_SIZE + 32;

// Class index mapping — alphabetical, matches the training notebook's
// ImageFolder ordering (training/notebooks/finetune.ipynb). DO NOT reorder.
const CLASS_ORDER: NsfwClass[] = ['explicit', 'gore', 'neutral', 'suggestive'];

// ImageNet normalisation — ViT standard, matches Marqo's training preprocessing
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

// ---------------------------------------------------------------------------
// ORT configuration (one-time)
// ---------------------------------------------------------------------------

// Single-threaded SIMD: avoids the SharedArrayBuffer / COOP-COEP dance that
// threaded mode would require in an extension page. WASM is auto-copied to
// the extension root by `npm run wasm:copy` (see package.json) so it sits
// next to the .onnx model and can be loaded via the extension origin.
ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = chrome.runtime.getURL('');

// ---------------------------------------------------------------------------
// Session management — load model once, reuse across requests
// ---------------------------------------------------------------------------

let sessionPromise: Promise<ort.InferenceSession> | null = null;

function getSession(): Promise<ort.InferenceSession> {
    if (sessionPromise) return sessionPromise;
    sessionPromise = (async () => {
        // Model bytes come from the CDN (Cache API'd after first hit) with
        // a bundled fallback. See model-loader.ts for the policy.
        const modelBytes = await loadModelBytes();
        const t0 = performance.now();
        const session = await ort.InferenceSession.create(modelBytes, {
            executionProviders: ['wasm'],
        });
        logger.debug('[NSFW] ✅ model ready', {
            createMs: Math.round(performance.now() - t0),
            inputs: session.inputNames,
            outputs: session.outputNames,
        });
        return session;
    })().catch(err => {
        sessionPromise = null; // allow retry on next call
        throw err;
    });
    return sessionPromise;
}

// ---------------------------------------------------------------------------
// Preprocessing — ImageBitmap → CHW float32 with ImageNet normalisation
// ---------------------------------------------------------------------------

function preprocess(bitmap: ImageBitmap): Float32Array {
    const canvas = new OffscreenCanvas(MODEL_INPUT_SIZE, MODEL_INPUT_SIZE);
    const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | null;
    if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable');

    // Aspect-preserving resize + center crop (NOT a stretch to 384×384).
    // Training never saw squashed images; stretching 4:5 posts and 9:16 reel
    // covers was a source of confident false positives. Scaling the short
    // side to 416 then cropping the central 384 square is equivalent to
    // cropping a (short × 384/416) square from the source and scaling it.
    const shortSide = Math.min(bitmap.width, bitmap.height);
    const cropSide = shortSide * (MODEL_INPUT_SIZE / RESIZE_SHORT_SIDE);
    const sx = (bitmap.width - cropSide) / 2;
    const sy = (bitmap.height - cropSide) / 2;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, sx, sy, cropSide, cropSide, 0, 0, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE);

    const { data } = ctx.getImageData(0, 0, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE);
    const pixels = MODEL_INPUT_SIZE * MODEL_INPUT_SIZE;
    const out = new Float32Array(3 * pixels);

    for (let i = 0; i < pixels; i++) {
        const r = data[i * 4] / 255;
        const g = data[i * 4 + 1] / 255;
        const b = data[i * 4 + 2] / 255;
        out[i] = (r - MEAN[0]) / STD[0];
        out[pixels + i] = (g - MEAN[1]) / STD[1];
        out[pixels * 2 + i] = (b - MEAN[2]) / STD[2];
    }
    return out;
}

function softmaxN(logits: ArrayLike<number>): number[] {
    const n = logits.length;
    let max = -Infinity;
    for (let i = 0; i < n; i++) if (logits[i] > max) max = logits[i];
    const ex: number[] = new Array(n);
    let sum = 0;
    for (let i = 0; i < n; i++) {
        const e = Math.exp(logits[i] - max);
        ex[i] = e;
        sum += e;
    }
    for (let i = 0; i < n; i++) ex[i] /= sum;
    return ex;
}

// ---------------------------------------------------------------------------
// Inference
// ---------------------------------------------------------------------------

/** Failure result — all-neutral with high confidence so the runtime ALLOWs. */
function failureResult(reason: string): NSFWAnalysisResult {
    return {
        scores: { explicit: 0, gore: 0, neutral: 1, suggestive: 0 },
        predictedClass: 'neutral',
        reasons: [reason],
    };
}

async function analyzeNSFW(imageUrl: string): Promise<NSFWAnalysisResult> {
    const domain = (() => { try { return new URL(imageUrl).hostname; } catch { return '(invalid)'; } })();
    logger.debug('[NSFW] fetch start →', { domain, urlPrefix: imageUrl.slice(0, 120) });

    let blob: Blob;
    try {
        const resp = await fetch(imageUrl, { mode: 'cors', credentials: 'omit' });
        if (!resp.ok) throw new Error(`Fetch failed: ${resp.status}`);
        blob = await resp.blob();
        logger.debug('[NSFW] ✅ fetch OK →', { domain, bytes: blob.size, type: blob.type });
    } catch (err) {
        console.error('[Lucid:NSFW] ❌ fetch FAILED →', { domain, error: (err as Error).message });
        return failureResult(`NSFW: image fetch failed — ${(err as Error).message}`);
    }

    let bitmap: ImageBitmap;
    try {
        bitmap = await createImageBitmap(blob);
    } catch {
        return failureResult('NSFW: ImageBitmap decode failed');
    }

    let chwFloat: Float32Array;
    try {
        chwFloat = preprocess(bitmap);
    } catch (err) {
        bitmap.close();
        return failureResult(`NSFW: preprocess failed — ${(err as Error).message}`);
    }
    bitmap.close();

    try {
        const session = await getSession();
        const inputName = session.inputNames[0];
        const outputName = session.outputNames[0];

        const tensor = new ort.Tensor('float32', chwFloat, [1, 3, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE]);
        const t0 = performance.now();
        const output = await session.run({ [inputName]: tensor });
        const inferenceMs = Math.round(performance.now() - t0);

        // 4 logits → softmax → per-class probs. Class order is alphabetical:
        // [explicit, gore, neutral, suggestive] per CLASS_ORDER above.
        const logits = output[outputName].data as Float32Array;
        const probs = softmaxN(logits);

        const scores = {
            explicit: probs[0],
            gore: probs[1],
            neutral: probs[2],
            suggestive: probs[3],
        };

        // argmax → predicted class
        let topIdx = 0;
        for (let i = 1; i < CLASS_ORDER.length; i++) {
            if (probs[i] > probs[topIdx]) topIdx = i;
        }
        const predictedClass = CLASS_ORDER[topIdx];

        logger.debug('[NSFW] inference →', {
            domain,
            explicit: scores.explicit.toFixed(3),
            gore: scores.gore.toFixed(3),
            neutral: scores.neutral.toFixed(3),
            suggestive: scores.suggestive.toFixed(3),
            top: predictedClass,
            ms: inferenceMs,
        });

        const reasons: string[] = [];
        if (predictedClass !== 'neutral') {
            reasons.push(`${predictedClass} detected (${(probs[topIdx] * 100).toFixed(0)}%)`);
        }
        return { scores, predictedClass, reasons };
    } catch (err) {
        return failureResult(`NSFW: inference error — ${(err as Error).message}`);
    }
}

// ---------------------------------------------------------------------------
// Message routing
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'OFFSCREEN_ANALYZE_NSFW') {
        const url = msg.imageUrl as string;
        logger.debug('[NSFW] received OFFSCREEN_ANALYZE_NSFW →', url.slice(0, 100));
        analyzeNSFW(url)
            .then(result => {
                logger.debug('[NSFW] sending result back →', result.predictedClass, result.scores);
                sendResponse({ ok: true, result });
            })
            .catch(err => {
                console.error('[Lucid:NSFW] analyzeNSFW threw →', (err as Error).message);
                sendResponse({ ok: false, error: (err as Error).message });
            });
        return true;
    }

    if (msg.type === 'OFFSCREEN_SCRAPE_RECORD') {
        const payload = msg.payload as ScrapeRecordPayload;
        recordScrape(payload)
            .then(result => {
                if (result.deduped) {
                    console.log('[Lucid:scrape] dedup', payload.item_id);
                } else {
                    console.log('[Lucid:scrape] stored', { id: payload.item_id, bytes: result.bytes });
                }
                sendResponse(result);
            })
            .catch(err => {
                console.error('[Lucid:scrape] failed →', (err as Error).message);
                sendResponse({ ok: false, error: (err as Error).message });
            });
        return true;
    }

    return false;
});

// Warm the model on document load so the first user-triggered inference
// doesn't pay the ~500 ms load cost.
void getSession().catch(err => {
    console.error('[Lucid:NSFW] cold-load failed →', (err as Error).message);
});
