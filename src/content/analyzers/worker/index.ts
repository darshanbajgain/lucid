import type {
    VisionAnalysisResult,
    NSFWAnalysisResult,
    WorkerRequest,
    WorkerNSFWRequest,
    WorkerResultMessage,
    WorkerNSFWResultMessage,
} from './protocol';
import { logger } from '../../../utils/logger';

/**
 * Concurrency-Limited Semaphore
 *
 * Prevents flooding the offscreen document with simultaneous NSFWJS requests.
 * CPU-based inference is sequential (~1-2s per image), so sending 30 requests
 * at once just causes timeouts for later items. The semaphore ensures at most
 * `maxConcurrent` requests are in-flight; the rest wait in a FIFO queue.
 */
class Semaphore {
    private readonly queue: (() => void)[] = [];
    private running = 0;

    constructor(private readonly maxConcurrent: number) {}

    get pending(): number { return this.queue.length; }

    async acquire(): Promise<void> {
        if (this.running < this.maxConcurrent) {
            this.running++;
            return;
        }
        return new Promise<void>(resolve => {
            this.queue.push(() => {
                this.running++;
                resolve();
            });
        });
    }

    release(): void {
        this.running--;
        const next = this.queue.shift();
        if (next) next();
    }
}

/**
 * Singleton Proxy for Visual Analysis
 *
 * Instead of spawning a Web Worker in the content script (which violates
 * Instagram's strict `worker-src` CSP), this bridge proxies requests to the
 * Background Service Worker using `chrome.runtime.sendMessage`.
 *
 * Cold-start safety: MV3 service workers sleep after ~30s of inactivity.
 * The bridge sends a PING message before the first analysis request to
 * force Chrome to wake the worker, preventing silent message drops.
 *
 * NSFWJS requests are throttled via a Semaphore (max 2 concurrent) to prevent
 * overwhelming the single-threaded CPU backend in the offscreen document.
 * The 15s timeout only starts AFTER the semaphore grants access, so queued
 * items don't time out while waiting their turn.
 */
class WorkerBridge {
    private requestCounter = 0;
    private isAwake = false;
    private awakeTimeout: ReturnType<typeof setTimeout> | null = null;

    /**
     * Max 2 concurrent NSFWJS requests to the offscreen document.
     * Higher values don't help because inference is CPU-bound and sequential,
     * but 2 allows fetch overlap (image N+1 fetches while image N infers).
     */
    private readonly nsfwSemaphore = new Semaphore(2);

    /** Timeout per inference AFTER the semaphore grants access. */
    private static readonly NSFW_TIMEOUT_MS = 15_000;

    private resetAwakeTimer() {
        if (this.awakeTimeout) clearTimeout(this.awakeTimeout);
        this.awakeTimeout = setTimeout(() => { this.isAwake = false; }, 25000);
    }

    private async ensureAwake(): Promise<void> {
        if (this.isAwake) return;
        // Worker may not respond to PING — the message itself wakes it,
        // so any error here is expected and ignored.
        await chrome.runtime.sendMessage({ type: 'PING' }).catch(() => undefined);
        this.isAwake = true;
        this.resetAwakeTimer();
    }

    private nextId(): string {
        return `req_${Date.now()}_${this.requestCounter++}`;
    }

    // ---------------------------------------------------------------------------
    // YCrCb (thesis bias example — called only when enableVisionYCrCb = true)
    // ---------------------------------------------------------------------------

    public async analyze(
        pixels: Uint8ClampedArray,
        width: number,
        height: number
    ): Promise<VisionAnalysisResult> {
        await this.ensureAwake();
        this.resetAwakeTimer();

        return new Promise((resolve, reject) => {
            const id = this.nextId();
            const request: WorkerRequest = {
                id,
                type: 'ANALYZE_VISION',
                payload: {
                    pixels: Array.from(pixels) as unknown as Uint8ClampedArray,
                    width,
                    height,
                },
            };

            const timeoutId = setTimeout(() => {
                reject(new Error(`Worker request ${id} timed out after 5000ms`));
            }, 5000);

            try {
                chrome.runtime.sendMessage(request, (response: WorkerResultMessage) => {
                    clearTimeout(timeoutId);
                    if (chrome.runtime.lastError) {
                        this.isAwake = false;
                        return reject(new Error(chrome.runtime.lastError.message));
                    }
                    if (!response) return reject(new Error('No response from background script'));
                    if (response.error) return reject(new Error(response.error));
                    if (response.payload) return resolve(response.payload);
                    return reject(new Error('Empty response payload'));
                });
            } catch (err) {
                clearTimeout(timeoutId);
                reject(err);
            }
        });
    }

    // ---------------------------------------------------------------------------
    // NSFWJS (Phase B — primary NSFW signal)
    // ---------------------------------------------------------------------------

    public async analyzeNSFW(imageUrl: string): Promise<NSFWAnalysisResult> {
        // [PAGE CONSOLE] — visible in Instagram tab DevTools (F12)
        const domain = (() => { try { return new URL(imageUrl).hostname; } catch { return '(invalid)'; } })();
        const queueDepth = this.nsfwSemaphore.pending;

        if (queueDepth > 0) {
            logger.debug(`[BRIDGE] analyzeNSFW queued (${queueDepth} ahead) →`, { domain });
        }

        // ── Wait for semaphore slot ──
        // Timeout does NOT run while queued — only after we acquire the slot.
        await this.nsfwSemaphore.acquire();

        try {
            await this.ensureAwake();
            this.resetAwakeTimer();

            logger.debug('[BRIDGE] analyzeNSFW processing →', { domain, urlPrefix: imageUrl.slice(0, 100) });

            return await new Promise<NSFWAnalysisResult>((resolve, reject) => {
                const id = this.nextId();
                const request: WorkerNSFWRequest = {
                    id,
                    type: 'ANALYZE_NSFW',
                    payload: { imageUrl },
                };

                // Timeout starts NOW — after acquiring semaphore slot
                const timeoutId = setTimeout(() => {
                    reject(new Error(`NSFW request ${id} timed out after ${WorkerBridge.NSFW_TIMEOUT_MS}ms`));
                }, WorkerBridge.NSFW_TIMEOUT_MS);

                try {
                    chrome.runtime.sendMessage(request, (response: WorkerNSFWResultMessage) => {
                        clearTimeout(timeoutId);
                        if (chrome.runtime.lastError) {
                            console.error('[Lucid:BRIDGE] ❌ runtime error →', chrome.runtime.lastError.message);
                            this.isAwake = false;
                            return reject(new Error(chrome.runtime.lastError.message));
                        }
                        if (!response) {
                            console.error('[Lucid:BRIDGE] ❌ no response from SW');
                            return reject(new Error('No response from background script'));
                        }
                        if (response.error) {
                            console.error('[Lucid:BRIDGE] ❌ SW returned error →', response.error);
                            return reject(new Error(response.error));
                        }
                        if (response.payload) {
                            logger.debug('[BRIDGE] ✅ NSFW result →', {
                                predicted: response.payload.predictedClass,
                                explicit: response.payload.scores.explicit.toFixed(3),
                                gore: response.payload.scores.gore.toFixed(3),
                                neutral: response.payload.scores.neutral.toFixed(3),
                                suggestive: response.payload.scores.suggestive.toFixed(3),
                                reasons: response.payload.reasons,
                            });
                            return resolve(response.payload);
                        }
                        return reject(new Error('Empty response payload'));
                    });
                } catch (err) {
                    clearTimeout(timeoutId);
                    reject(err);
                }
            });
        } finally {
            // Always release the semaphore — even on timeout/error
            this.nsfwSemaphore.release();
        }
    }

}

export const workerBridge = new WorkerBridge();
