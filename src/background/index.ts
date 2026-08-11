import { evaluatePixels } from '../content/analyzers/worker/vision-worker';
import type { AnyWorkerRequest, NSFWAnalysisResult } from '../content/analyzers/worker/protocol';
import { logger } from '../utils/logger';

/**
 * Lucid Background Service Worker — pure on-device runtime
 *
 * No cloud-API routes. The classifiers under `src/background/classifiers/`
 * still exist but are reserved for offline scripts (Sprint 4 benchmark
 * labeling, Sprint 4.5 fine-tuning data labeling). At runtime the SW only
 * relays vision work to the offscreen document.
 *
 * [SERVICE WORKER CONSOLE] — chrome://extensions → Lucid → "service worker" link
 *
 * Handles:
 *  PING           — wake-up handshake (MV3 workers sleep after ~30s)
 *  ANALYZE_VISION — YCrCb skin detection (pure JS, safe in service worker)
 *  ANALYZE_NSFW   — proxied to offscreen document → Marqo ONNX inference
 *                    (was NSFWJS before Sprint 3, 2026-05-11)
 *  SCRAPE_RECORD  — proxied to offscreen → IDB-backed dataset capture
 *                    (Sprint 4; only active when lucid_scrape_mode=true)
 */

const OFFSCREEN_URL = chrome.runtime.getURL('offscreen.html');

chrome.runtime.onInstalled.addListener(() => {
    void enableSessionStorageForContentScripts();
});
chrome.runtime.onStartup.addListener(() => {
    void enableSessionStorageForContentScripts();
});

/**
 * chrome.storage.session is locked to privileged contexts (SW / popup /
 * options) by default. Content scripts get "Access to storage is not allowed
 * from this context" on get/set. The intent check-in (G5) and any future
 * session-scoped state needs read/write access from the content script, so
 * we opt into TRUSTED_AND_UNTRUSTED_CONTEXTS once on install/startup.
 */
async function enableSessionStorageForContentScripts(): Promise<void> {
    try {
        await chrome.storage.session.setAccessLevel({
            accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS',
        });
    } catch (e) {
        console.warn('[Lucid:SW] setAccessLevel failed:', (e as Error).message);
    }
}

/**
 * Mutex for offscreen document creation.
 *
 * The promise is set SYNCHRONOUSLY before any await — without this, two
 * concurrent ANALYZE_NSFW requests can both pass the null-check and both
 * call createDocument(), throwing "Only a single offscreen document may
 * be created."
 *
 * The promise is also kept after success (not nulled) so that subsequent
 * requests await the same listener-ready signal. Otherwise a third
 * request arriving between createDocument() resolving and the 300 ms
 * listener-ready window throws "Could not establish connection."
 *
 * Cleared only on real failure or on a connection error from sendMessage,
 * so the next call rebuilds.
 */
let offscreenPromise: Promise<void> | null = null;

function ensureOffscreen(): Promise<void> {
    if (offscreenPromise) return offscreenPromise;

    offscreenPromise = (async () => {
        try {
            const exists = await chrome.offscreen.hasDocument();
            if (!exists) {
                logger.debug('[SW] creating offscreen document...');
                try {
                    await chrome.offscreen.createDocument({
                        url: OFFSCREEN_URL,
                        reasons: [chrome.offscreen.Reason.BLOBS],
                        justification: 'On-device NSFW classification via onnxruntime-web; the offscreen doc provides the DOM/canvas context the WASM runtime needs',
                    });
                } catch (e) {
                    // Race against another extension page (popup) that beat us
                    // to it — the doc exists, so this error is benign.
                    const msg = e instanceof Error ? e.message : '';
                    if (!msg.includes('single offscreen document')) throw e;
                }
            }
            // Always wait the listener-ready window even if doc already
            // existed — the listener may not be registered yet.
            await new Promise(resolve => setTimeout(resolve, 300));
            logger.debug('[SW] offscreen document ready');
        } catch (err) {
            offscreenPromise = null;
            throw err;
        }
    })();

    return offscreenPromise;
}

/** Drop the cached ready-promise so the next request rebuilds. */
function invalidateOffscreen(): void {
    offscreenPromise = null;
}

chrome.runtime.onMessage.addListener(
    (request: AnyWorkerRequest, _sender, sendResponse) => {
        if (request.type === 'PING') {
            sendResponse({ type: 'PONG' });
            return false;
        }

        if (request.type === 'ANALYZE_VISION') {
            let pixels = request.payload.pixels;
            if (!(pixels instanceof Uint8ClampedArray)) {
                const arr = Array.isArray(pixels) ? pixels : Object.values(pixels) as number[];
                pixels = new Uint8ClampedArray(arr);
            }
            try {
                const result = evaluatePixels(pixels, request.payload.width, request.payload.height);
                sendResponse({ id: request.id, type: 'ANALYZE_VISION_RESULT', payload: result });
            } catch (e: unknown) {
                const message = e instanceof Error ? e.message : 'Evaluation error';
                sendResponse({ id: request.id, type: 'ANALYZE_VISION_RESULT', error: message });
            }
            return false;
        }

        if (request.type === 'SCRAPE_RECORD') {
            const payload = request.payload;
            const requestId = request.id;

            ensureOffscreen()
                .then(() => chrome.runtime.sendMessage({
                    type: 'OFFSCREEN_SCRAPE_RECORD',
                    payload,
                }))
                .then((resp: { ok: boolean; bytes?: number; deduped?: true; error?: string }) => {
                    if (resp?.ok) {
                        sendResponse({
                            id: requestId,
                            type: 'SCRAPE_RECORD_RESULT',
                            payload: { ok: true, bytes: resp.bytes ?? 0 },
                        });
                    } else {
                        sendResponse({ id: requestId, type: 'SCRAPE_RECORD_RESULT', error: resp?.error ?? 'scrape offscreen returned no result' });
                    }
                })
                .catch((e: unknown) => {
                    const message = e instanceof Error ? e.message : 'scrape offscreen error';
                    if (message.includes('Could not establish connection') ||
                        message.includes('No offscreen document')) {
                        invalidateOffscreen();
                    }
                    sendResponse({ id: requestId, type: 'SCRAPE_RECORD_RESULT', error: message });
                });
            return true;
        }

        if (request.type === 'ANALYZE_NSFW') {
            const { imageUrl } = request.payload;
            const requestId = request.id;

            logger.debug('[SW] ANALYZE_NSFW →', imageUrl);

            ensureOffscreen()
                .then(() => {
                    logger.debug('[SW] forwarding to offscreen doc');
                    return chrome.runtime.sendMessage({
                        type: 'OFFSCREEN_ANALYZE_NSFW',
                        imageUrl,
                    });
                })
                .then((resp: { ok: boolean; result?: NSFWAnalysisResult; error?: string }) => {
                    if (resp?.ok && resp.result) {
                        logger.debug('[SW] ✅ offscreen returned →',
                            resp.result.predictedClass,
                            `(explicit=${resp.result.scores.explicit.toFixed(2)}, gore=${resp.result.scores.gore.toFixed(2)}, neutral=${resp.result.scores.neutral.toFixed(2)}, suggestive=${resp.result.scores.suggestive.toFixed(2)})`);
                        sendResponse({ id: requestId, type: 'ANALYZE_NSFW_RESULT', payload: resp.result });
                    } else {
                        console.error('[Lucid:SW] ❌ offscreen error:', resp?.error);
                        sendResponse({ id: requestId, type: 'ANALYZE_NSFW_RESULT', error: resp?.error ?? 'Offscreen returned no result' });
                    }
                })
                .catch((e: unknown) => {
                    const message = e instanceof Error ? e.message : 'NSFW offscreen error';
                    console.error('[Lucid:SW] ❌ threw:', message);
                    // If the listener wasn't ready or the doc was disposed,
                    // drop the cached promise so the next call rebuilds.
                    if (message.includes('Could not establish connection') ||
                        message.includes('No offscreen document')) {
                        invalidateOffscreen();
                    }
                    sendResponse({ id: requestId, type: 'ANALYZE_NSFW_RESULT', error: message });
                });
            return true; // keep message channel open for async sendResponse
        }

        return false;
    }
);
