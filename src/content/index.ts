import { initObserver } from "./observer";
import type { ScannedItem, PlatformStrategy } from "./observer";
import { runStage1, runStage2, getMode, getBlocklistTerms } from "./pipeline/analyze";
import { checkBlocklist, loadBlocklistSettings, activeTerms } from "./engine/blocklist";
import type { FullResult } from "./pipeline/analyze";
import { combineDecision, modeUsesImage } from "./engine/scorer";
import type { ClassifierMode } from "./engine/strictness";
import { InstagramStrategy } from "./platforms/instagram";
import { TikTokStrategy } from "./platforms/tiktok";
import { applyBlur, applyProvisionalBlur } from "./ui/blur";
import { logger } from "../utils/logger";
import { record, recordInference } from "./analytics/engine";
import { sessionEngine } from "./engine/session";
import type { InterventionLevel } from "./engine/session";
import { getCachedResult, setCachedResult, evictRecomputableVerdicts } from "./cache/result-cache";
import type { CachedVerdict } from "./cache/result-cache";
import { mountTimerPill } from "./ui/timer-pill";
import { initScrapeMode, isScrapeMode, recordScrapeItem } from "./scrape/recorder";

// ---------------------------------------------------------------------------
// Extension-context invalidation guard
// ---------------------------------------------------------------------------
//
// When the user reloads or updates Lucid while Instagram is open, this
// content script keeps running in the page but its references to
// `chrome.runtime` and `chrome.storage` become invalid. Any subsequent
// API call rejects with "Extension context invalidated." — observers,
// intervals, and event handlers that survived the reload spam the
// console with these errors until Chrome GCs them.
//
// We can't prevent the script from being orphaned, but we can:
//   1. Detect the invalid state via `chrome.runtime?.id` (becomes undefined).
//   2. Swallow the specific error globally so it doesn't surface to the page.
//   3. Let the orphaned script die quietly; the new script in the next page
//      load takes over.

function isContextInvalidatedError(err: unknown): boolean {
    return (
        err instanceof Error &&
        typeof err.message === 'string' &&
        err.message.includes('Extension context invalidated')
    );
}

export function isExtensionContextValid(): boolean {
    try {
        return !!chrome.runtime?.id;
    } catch {
        return false;
    }
}

window.addEventListener('error', (e) => {
    if (isContextInvalidatedError(e.error)) {
        e.preventDefault();
        e.stopImmediatePropagation();
    }
});

window.addEventListener('unhandledrejection', (e) => {
    if (isContextInvalidatedError(e.reason)) {
        e.preventDefault();
    }
});

/**
 * Lucid Entry Point — Lucid v2.2 multimodal
 *
 * Progressive two-stage flow:
 *   1. SessionEngine.init() — restore persisted session state before anything runs.
 *   2. Observer detects new content.
 *   3. L1/L2 cache check (instant blur if hit).
 *   4. **Stage 1** (synchronous, ~5 ms) — text analyzer. If it fires, APPLY
 *      blur IMMEDIATELY (no 700 ms flash of distractive content).
 *   5. **Stage 2** (async, ~700 ms) — image classifier. Only runs in Smart /
 *      Strict modes. Recombines text + image into a final decision. May
 *      relabel / upgrade the blur. Never unblurs (sticky-blur invariant).
 *   6. Cache the final verdict + record analytics + emit verdict log.
 */

// ---------------------------------------------------------------------------
// In-memory result cache (L1)
// ---------------------------------------------------------------------------

interface CachedResult {
    readonly score: number;
    readonly reasons: string[];
    readonly source?: string;
    readonly label?: string;
    readonly provider?: string;
}
const resultCache = new Map<string, CachedResult>();

const MAX_L1_CACHE_SIZE = 500;

function evictL1IfNeeded(): void {
    if (resultCache.size <= MAX_L1_CACHE_SIZE) return;
    const oldest = resultCache.keys().next().value;
    if (oldest !== undefined) resultCache.delete(oldest);
}

// ---------------------------------------------------------------------------
// Decision-recording dedup
// ---------------------------------------------------------------------------

const recordedDecisionIds = new Set<string>();
const MAX_RECORDED_IDS = 500;

function evictRecordedIdsIfNeeded(): void {
    if (recordedDecisionIds.size <= MAX_RECORDED_IDS) return;
    const oldest = recordedDecisionIds.values().next().value;
    if (oldest !== undefined) recordedDecisionIds.delete(oldest);
}

function recordDecision(level: InterventionLevel | null): void {
    record("scanned");
    if (level === null) {
        record("allowed");
    } else {
        if (level === 3) record("blocked");
        else record("warned");
        sessionEngine.recordBlur();
    }
}

// ---------------------------------------------------------------------------
// Verdict log — Lucid v2.2 multimodal shape
// ---------------------------------------------------------------------------

interface VerdictLogParams {
    item: ScannedItem;
    level: InterventionLevel | null;
    source: 'image' | 'blocklist' | 'none' | 'cache';
    label: string;
    score: number;
    reasons: string[];
    imageScores?: { explicit: number; gore: number; neutral: number; suggestive: number } | null;
    stage: 'text' | 'image_confirmed' | 'image_only' | 'L1-cache' | 'L2-cache';
    mode: ClassifierMode;
}

// One concise line per rendered post — the only always-on log. Shows the
// verdict + the signal that drove it: for image decisions the four class
// scores (spot false positives at a glance), for text decisions the matched
// blocklist terms. All the pipeline plumbing logs are gated behind
// `logger.debug` (dev-only) so the production console stays this clean.
function logVerdict(p: VerdictLogParams): void {
    const verdict = p.level === null ? 'ALLOW' : `BLUR L${p.level}`;
    const caption = (p.item.caption ?? '').replace(/\s+/g, ' ').slice(0, 70);
    const s = p.imageScores;
    const detail = s
        ? `explicit=${s.explicit.toFixed(2)} gore=${s.gore.toFixed(2)} neutral=${s.neutral.toFixed(2)} suggestive=${s.suggestive.toFixed(2)}`
        : p.reasons.length ? p.reasons.join(', ') : p.source;
    const who = p.item.author ? ` @${p.item.author}` : '';
    console.log(`[Lucid] ${verdict} · ${detail} ·${who} "${caption}"`);
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

Promise.all([
    sessionEngine.init(),
    initScrapeMode(),
]).then(() => {
    logger.debug("SessionEngine + scrape flag ready — starting observer");
    injectLucidStyles();
    watchTikTokModalUrl();
    watchBlocklistChanges();
    startObserver();
    void mountTimerPill();
}).catch((e) => {
    logger.error("SessionEngine init failed, starting observer anyway", e);
    injectLucidStyles();
    watchTikTokModalUrl();
    watchBlocklistChanges();
    startObserver();
    void mountTimerPill();
});

// ---------------------------------------------------------------------------
// Blocklist live-edit → un-blur stale posts
// ---------------------------------------------------------------------------

/** Active platform strategy for this tab, by hostname (mirrors observer gate). */
function activeStrategy(): PlatformStrategy {
    return location.hostname.includes('tiktok.com') ? TikTokStrategy : InstagramStrategy;
}

/**
 * When the user edits the blocklist (adds/removes a term, toggles a
 * category), every post must be re-evaluated against the new term list.
 * Three populations:
 *
 *   1. Newly rendered    → re-evaluated fresh by the pipeline ✓ (already works)
 *   2. Still on screen    → overlay mounted / no overlay; nothing re-evaluates ✗
 *   3. Scrolled away+back  → L1/L2 cache hit re-applies the stale verdict ✗
 *
 * This handler fixes 2 and 3, in BOTH directions:
 *   - a blocklist-blurred post that no longer matches → unblur
 *   - an allowed post that now matches a new term → blur
 *   - an image-blurred post → left untouched (image is an independent signal,
 *     expensive to recompute, and not affected by the blocklist)
 *
 * This is a deliberate, user-initiated re-evaluation; it does NOT violate the
 * sticky-blur invariant, which only governs the Stage-1/Stage-2 pipeline.
 */
function watchBlocklistChanges(): void {
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes.lucid_blocklist) return;
        void reconcileBlocklist();
    });
}

async function reconcileBlocklist(): Promise<void> {
    // Load terms + mode fresh (don't rely on the pipeline's cached getters —
    // their onChanged listeners race with this one).
    const terms = activeTerms(await loadBlocklistSettings());
    const mode = await getMode();
    const strat = activeStrategy();

    // (2) On-screen: re-check every processed post against the new terms.
    const posts = document.querySelectorAll<HTMLElement>('[data-lucid-processed]');
    for (const container of Array.from(posts)) {
        // Image-blurred posts are independent of the blocklist — leave them.
        if (container.dataset.lucidSource === 'image') continue;

        const caption = strat.getCaption(container);
        const blocklistMatch = checkBlocklist(caption, terms);
        // image scores intentionally null — we're only re-evaluating the
        // blocklist dimension, not re-running the (expensive) image model.
        const decision = combineDecision(null, mode, blocklistMatch);

        if (decision.fires) {
            // Now matches → (re)apply blocklist blur. No-op visually if it was
            // already blocklist-blurred for the same reason.
            const level = sessionEngine.getLevel(decision.finalScore);
            applyBlur(
                container,
                level,
                decision.finalScore,
                decision.reasons,
                strat.uiConfig,
                decision.label,
                decision.source,
            );
        } else if (container.dataset.lucidSource === 'blocklist') {
            // Was blocklist-blurred, no longer matches → unblur.
            applyBlur(container, null, 0, [], undefined, undefined);
        }
    }

    // (3) Evict recomputable (non-image) verdicts from both caches so
    // off-screen posts re-evaluate against the new term list on next render.
    for (const [id, v] of resultCache) {
        if (v.source !== 'image') resultCache.delete(id);
    }
    await evictRecomputableVerdicts();
}

/**
 * Inject Lucid's content stylesheet. Two concerns:
 *
 *  1. Visually clamp expanded IG captions so the blur overlay (sized 100%
 *     to the article) stays compact. Scoped to data-lucid-expanded posts.
 *
 *  2. Hide blur overlays globally when TikTok is showing a single-video
 *     modal (URL pattern /<...>/video/<id>). Without this, the grid items
 *     behind the modal still have their `position: absolute` overlays at
 *     z-index 9999, which leak through TikTok's modal backdrop and look
 *     like duplicate blurs inside the modal.
 */
function injectLucidStyles(): void {
    if (document.getElementById('lucid-content-styles')) return;
    const style = document.createElement('style');
    style.id = 'lucid-content-styles';
    style.textContent = `
        article[data-lucid-expanded="true"] span._aacu {
            display: -webkit-box;
            -webkit-line-clamp: 3;
            -webkit-box-orient: vertical;
            overflow: hidden;
            max-height: 4.5em;
        }

        /* TikTok modal handling — when the user is in a single-video cinema
           mode modal (URL contains /video/<id>), hide all Lucid overlays
           that aren't INSIDE the modal player. This kills grid overlays
           bleeding through TikTok's backdrop while still allowing the
           modal video to display its own blur (re-hydrated from L2 cache
           because the modal's xgwrapper ID matches the grid item's). */
        body[data-lucid-tt-modal="true"] [data-lucid-overlay="true"] {
            display: none !important;
        }
        body[data-lucid-tt-modal="true"]
        [data-cinema-mode-player-interaction-layer] [data-lucid-overlay="true"] {
            display: flex !important;
        }
    `;
    document.head.appendChild(style);
}

/**
 * Track TikTok modal state by URL pattern. When the URL matches
 * /<...>/video/<digits>, TikTok is showing a single-video modal on top of
 * whatever page came before (profile grid, explore, search, etc). We flip
 * a body attribute that the CSS above keys off to suppress all Lucid
 * overlays. Polling because TikTok navigates via history.pushState which
 * doesn't fire popstate — listening for popstate alone would miss
 * forward navigations.
 */
function watchTikTokModalUrl(): void {
    if (!location.hostname.includes('tiktok.com')) return;

    const MODAL_URL_PATTERN = /\/video\/\d+/;
    let lastInModal: boolean | null = null;

    const sync = (): void => {
        const inModal = MODAL_URL_PATTERN.test(location.pathname);
        if (inModal === lastInModal) return;
        lastInModal = inModal;
        if (inModal) {
            document.body.dataset.lucidTtModal = 'true';
        } else {
            delete document.body.dataset.lucidTtModal;
        }
    };

    sync();
    setInterval(sync, 250);
}

// ---------------------------------------------------------------------------
// Observer + Progressive Pipeline
// ---------------------------------------------------------------------------

function startObserver(): void {
    initObserver((item) => {

        // Scrape mode — bypass everything, capture for the dataset
        if (isScrapeMode()) {
            recordScrapeItem(item);
            return;
        }

        // L1 fast path
        const cached = resultCache.get(item.id);
        if (cached) {
            const level = sessionEngine.getLevel(cached.score);
            applyBlur(item.container, level, cached.score, cached.reasons, item.uiConfig, cached.label, cached.source);
            logVerdict({
                item,
                level,
                source: 'cache',
                label: cached.label ?? '',
                score: cached.score,
                reasons: cached.reasons,
                stage: 'L1-cache',
                mode: 'off',  // unknown from cache hit
            });
            if (!recordedDecisionIds.has(item.id)) {
                recordedDecisionIds.add(item.id);
                evictRecordedIdsIfNeeded();
                recordDecision(level);
            }
            return;
        }

        // Slow path — L2 cache + progressive pipeline
        void runPipeline(item);
    });
}

async function runPipeline(item: ScannedItem): Promise<void> {
    try {
        // L2 persistent cache check
        const persistedHit = await getCachedResult(item.id);
        if (persistedHit) {
            const level = sessionEngine.getLevel(persistedHit.score);
            resultCache.set(item.id, {
                score: persistedHit.score,
                reasons: persistedHit.reasons,
                label: persistedHit.label,
                source: persistedHit.source,
            });
            evictL1IfNeeded();
            applyBlur(item.container, level, persistedHit.score, persistedHit.reasons, item.uiConfig, persistedHit.label, persistedHit.source);
            logVerdict({
                item,
                level,
                source: 'cache',
                label: persistedHit.label ?? '',
                score: persistedHit.score,
                reasons: persistedHit.reasons,
                stage: 'L2-cache',
                mode: 'off',
            });
            if (!recordedDecisionIds.has(item.id)) {
                recordedDecisionIds.add(item.id);
                evictRecordedIdsIfNeeded();
                recordDecision(level);
            }
            return;
        }

        const mode = await getMode();
        const t0 = performance.now();

        // ─── STAGE 1 — text-only (synchronous, ~5ms) ─────────────────────────
        const stage1 = await runStage1(item, mode);
        let stage1FiredLevel: InterventionLevel | null = null;

        let provisionalBlur = false;

        if (stage1.decision.fires) {
            stage1FiredLevel = sessionEngine.getLevel(stage1.decision.finalScore);
            applyBlur(
                item.container,
                stage1FiredLevel,
                stage1.decision.finalScore,
                stage1.decision.reasons,
                item.uiConfig,
                stage1.decision.label,
                stage1.decision.source,
            );
        } else if (modeUsesImage(mode) && item.thumbnail?.src) {
            // Optimistic pre-blur: Stage 1 didn't fire but the image classifier
            // is about to run (~700 ms, and later in a 2-wide queue on a busy
            // feed). Blur now so NSFW never flashes; reveal below if it's clean.
            applyProvisionalBlur(item.container, item.uiConfig);
            provisionalBlur = true;
        }

        // ─── STAGE 2 — image classifier (async, only in Smart / Strict) ─────
        const stage2: FullResult = await runStage2(item, mode, stage1);
        const inferenceMs = performance.now() - t0;

        // ─── Reconcile final decision ───────────────────────────────────────
        // Sticky-blur invariant: if Stage 1 fired, blur stays even if Stage 2 disagrees.
        // Stage 2 may UPGRADE (relabel to include image) or APPLY (if Stage 1 didn't fire).
        let finalFires: boolean;
        let finalDecision: typeof stage2.decision;
        let finalStage: 'text' | 'image_confirmed' | 'image_only';

        if (stage1.decision.fires && stage2.decision.fires) {
            // Both stages agree blur. Stage 2 may have a richer label ('both').
            finalFires = true;
            finalDecision = stage2.decision;
            finalStage = 'image_confirmed';
        } else if (stage1.decision.fires && !stage2.decision.fires) {
            // Text fired, image disagrees → blur stays sticky, keep text label.
            finalFires = true;
            finalDecision = stage1.decision;
            finalStage = 'text';
        } else if (!stage1.decision.fires && stage2.decision.fires) {
            // Text didn't fire, image did → apply blur now.
            finalFires = true;
            finalDecision = stage2.decision;
            finalStage = 'image_only';
        } else {
            // Neither fired → ALLOW.
            finalFires = false;
            finalDecision = stage2.decision;
            finalStage = 'image_only';
        }

        const finalLevel = finalFires ? sessionEngine.getLevel(finalDecision.finalScore) : null;

        // If Stage 2 changed the verdict (added image, or applied new), update the blur
        if (finalFires && (!stage1.decision.fires || finalDecision.source !== stage1.decision.source)) {
            applyBlur(
                item.container,
                finalLevel,
                finalDecision.finalScore,
                finalDecision.reasons,
                item.uiConfig,
                finalDecision.label,
                finalDecision.source,
            );
        } else if (!finalFires && provisionalBlur) {
            // Optimistic pre-blur was applied but the image came back clean —
            // reveal it. (This is NOT a sticky-blur violation: sticky only
            // protects a *fired* verdict; a provisional "pending" blur is
            // meant to clear when the content is confirmed safe.)
            applyBlur(item.container, null, 0, [], item.uiConfig);
        }

        // ─── Cache final verdict ────────────────────────────────────────────
        resultCache.set(item.id, {
            score: finalDecision.finalScore,
            reasons: finalDecision.reasons,
            label: finalDecision.label,
            source: finalDecision.source,
        });
        evictL1IfNeeded();

        const verdictForCache: CachedVerdict = {
            score: finalDecision.finalScore,
            reasons: finalDecision.reasons,
            label: finalDecision.label,
            source: finalDecision.source,
            imageScores: stage2.imageScores ?? undefined,
        };
        void setCachedResult(item.id, verdictForCache);

        // ─── Telemetry + verdict log ────────────────────────────────────────
        logVerdict({
            item,
            level: finalLevel,
            source: finalDecision.source,
            label: finalDecision.label,
            score: finalDecision.finalScore,
            reasons: finalDecision.reasons,
            imageScores: stage2.imageScores,
            stage: finalStage,
            mode,
        });

        recordedDecisionIds.add(item.id);
        evictRecordedIdsIfNeeded();
        recordDecision(finalLevel);
        recordInference(inferenceMs);

        // Set up a per-post watcher for caption expansion. IG lazy-renders
        // the full caption body + hashtag <a> elements after the post enters
        // the viewport or when the user clicks the "... more" button. We
        // need to re-analyze text when that happens.
        //
        // TikTok renders the full caption + hashtags up front on FYP, so the
        // watcher + "more"-button click are unnecessary (and would be a no-op
        // since neither the InstagramStrategy.getCaption call nor the
        // expandCaption click would find anything to do).
        if (item.platform === 'Instagram') {
            watchForCaptionExpansion(item, finalDecision.finalScore, mode);
        }
    } catch (e) {
        logger.error("Pipeline Error:", e);
        // If we pre-blurred and the pipeline then threw, don't leave a
        // provisional overlay stuck with no Reveal button. Clear it (fail-open,
        // matching the pre-provisional behaviour where an error meant no blur).
        const stuck = item.container.querySelector('[data-lucid-provisional="true"]');
        if (stuck) applyBlur(item.container, null, 0, [], item.uiConfig);
    }
}

// ---------------------------------------------------------------------------
// Caption-expansion watcher — handle IG's lazy caption rendering
// ---------------------------------------------------------------------------

/**
 * Watch the post container for DOM mutations and re-run text analysis if
 * the caption grows significantly. Common case: IG renders only the title +
 * "... more" button on initial scroll; the full caption body + hashtag <a>
 * elements get injected later (as the user scrolls into view or clicks
 * "more"). Without this watcher, those expanded captions never get
 * analyzed.
 *
 * Behaviour:
 *  - Watches childList + subtree mutations on item.container
 *  - On each mutation, re-extracts caption via the platform strategy
 *  - If caption grew by ≥ 30 chars from the last analyzed length, re-runs
 *    text analysis with the new caption
 *  - Applies blur (sticky — never unblurs) if the new text fires
 *  - Caps at 3 re-analyses per post; auto-disconnects after 30 s
 */
function watchForCaptionExpansion(
    item: ScannedItem,
    initialScore: number,
    mode: ClassifierMode,
): void {
    if (mode === 'off' || !item.container.isConnected) return;

    let lastAnalyzedLength = (item.caption || '').length;
    let reanalyzeCount = 0;
    const MAX_REANALYZES = 3;

    const mo = new MutationObserver(async () => {
        if (reanalyzeCount >= MAX_REANALYZES) {
            mo.disconnect();
            return;
        }

        const newCaption = InstagramStrategy.getCaption(item.container);
        const newLength = (newCaption || '').length;
        if (newLength <= lastAnalyzedLength + 30) return;

        reanalyzeCount++;
        (item as { caption: string | null }).caption = newCaption;
        lastAnalyzedLength = newLength;

        // Blocklist-only re-analysis. Image classifier already ran in the
        // initial pipeline; re-running it would double the CPU cost for
        // marginal gain. The blocklist is re-checked against the now-
        // expanded caption — IG often hides hashtags in the body that the
        // truncated preview didn't have.
        const blocklistTerms = await getBlocklistTerms();
        const blocklistMatch = checkBlocklist(newCaption, blocklistTerms);
        const decision = combineDecision(null, mode, blocklistMatch);

        if (!decision.fires) return;

        // Sticky-blur invariant: only apply if the new decision is stronger
        // than what we already showed. Avoids flickering relabels.
        if (decision.finalScore <= initialScore && initialScore > 0) return;

        const level = sessionEngine.getLevel(decision.finalScore);
        applyBlur(
            item.container,
            level,
            decision.finalScore,
            decision.reasons,
            item.uiConfig,
            decision.label,
            decision.source,
        );

        logVerdict({
            item,
            level,
            source: decision.source,
            label: decision.label,
            score: decision.finalScore,
            reasons: decision.reasons,
            stage: 'text',
            mode,
        });
    });

    mo.observe(item.container, { childList: true, subtree: true });

    // Trigger Instagram's "... more" expansion programmatically so IG injects
    // the full caption body + hashtag anchors into the DOM. The MutationObserver
    // above will catch the injected nodes and re-run text analysis.
    //
    // Why click rather than wait: IG keeps caption body + hashtags entirely
    // out of the feed DOM until the user (or this script) clicks "more". No
    // amount of waiting or scrolling will lazy-render it.
    //
    // We guard with WeakSet so we don't click the same post twice across the
    // initial scan + any follow-up mutations.
    if (InstagramStrategy.expandCaption && !expandedPosts.has(item.container)) {
        expandedPosts.add(item.container);
        try {
            const clicked = InstagramStrategy.expandCaption(item.container);
            if (clicked) {
                // Tag the article so our injected stylesheet clamps the now-
                // expanded caption back to ~3 lines visually. Analysis still
                // uses the full text via textContent (which ignores CSS).
                item.container.setAttribute('data-lucid-expanded', 'true');
            }
        } catch (e) {
            logger.warn('expandCaption failed', e);
        }
    }

    // Auto-disconnect after 30 s. Most caption expansions happen within
    // a few seconds of the post entering viewport; anything longer is
    // user-driven and we've likely captured what we need.
    setTimeout(() => mo.disconnect(), 30_000);
}

// Per-tab tracking so we never click the same post's "more" button twice.
const expandedPosts = new WeakSet<HTMLElement>();
