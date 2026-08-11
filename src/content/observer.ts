import { debounce } from "../utils/debounce";
import { logger } from "../utils/logger";

export interface ScannedItem {
    id: string; // Unique ID for tracking
    platform: 'YouTube' | 'Instagram' | 'TikTok';
    container: HTMLElement;
    video: HTMLVideoElement | null;
    thumbnail: HTMLImageElement | null;
    caption: string | null;
    author: string | null;
    uiConfig?: {
        overlayZIndex?: string;
        forceRelative?: boolean;
        customClass?: string;
    };
}

export interface PlatformStrategy {
    name: 'YouTube' | 'Instagram' | 'TikTok';
    selector: string;
    shouldWait: (container: HTMLElement) => boolean; // New: Predicate to decide if we should wait for more content (e.g. video load)
    shouldExclude?: (container: HTMLElement) => boolean; // New: Predicate to decide if this element should be ignored permanently
    getUniqueId: (container: HTMLElement) => string | null; // New: For deduplication
    getVideo: (container: HTMLElement) => HTMLVideoElement | null;
    getThumbnail: (container: HTMLElement) => HTMLImageElement | null;
    getCaption: (container: HTMLElement) => string | null;
    getAuthor: (container: HTMLElement) => string | null;
    /**
     * Optional: programmatically expand a truncated caption (e.g. click IG's
     * "... more" button) so the platform injects the full caption body +
     * hashtag anchors into the DOM. Returns true if a click was triggered.
     * Called once per post after the initial pipeline runs.
     */
    expandCaption?: (container: HTMLElement) => boolean;
    uiConfig?: {
        overlayZIndex?: string;
        forceRelative?: boolean;
        customClass?: string;
    };
}

import { InstagramStrategy } from "./platforms/instagram";
import { TikTokStrategy } from "./platforms/tiktok";

const STRATEGIES: PlatformStrategy[] = [
    InstagramStrategy,
    TikTokStrategy,
    /*
    // Future Platform Support (e.g., YouTube, Facebook)
    // To add a new platform, define a strategy here following the PlatformStrategy interface.
    //   {
    //       name: 'YouTube',
    //       selector: 'ytd-reel-video-renderer',
    //       ...
    //   },
    */
];

// Global set to track processed items across scans to prevent duplicates

// Hostname → strategy gate. Without this, the Instagram strategy (selector
// = 'article') would match TikTok's <article data-e2e="..."> containers,
// mark them processed, and the TikTok strategy would never get a chance.
function strategyMatchesHost(strategy: PlatformStrategy, host: string): boolean {
    if (strategy.name === 'Instagram') return host.includes('instagram.com');
    if (strategy.name === 'TikTok') return host.includes('tiktok.com');
    return true;
}

// Scan a specific root node (or document by default)
function scanRoot(root: ParentNode, callback: (item: ScannedItem) => void) {
    const host = location.hostname;
    for (const strategy of STRATEGIES) {
        if (!strategyMatchesHost(strategy, host)) continue;
        const containers = root.querySelectorAll(strategy.selector);
        containers.forEach((node) => processNode(node as HTMLElement, strategy, callback));
    }
}

export function initObserver(onNewItem: (item: ScannedItem) => void) {
    // 1. Debounced full scan (keep for safety/cleanup)
    const debouncedFullScan = debounce(() => scanRoot(document, onNewItem), 500);

    const observer = new MutationObserver((mutations) => {
        let shouldFullScan = false;

        for (const m of mutations) {
            if (m.type === 'childList') {
                // 2. Synchronous Scan of Added Nodes (Critical for speed)
                // Iterate over added nodes and check matches IMMEDIATELY to beat the paint frame.
                const host = location.hostname;
                m.addedNodes.forEach(node => {
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        const el = node as HTMLElement;
                        // Check if the node ITSELF matches specific strategies
                        for (const strategy of STRATEGIES) {
                            if (!strategyMatchesHost(strategy, host)) continue;
                            if (el.matches(strategy.selector)) {
                                processNode(el, strategy, onNewItem);
                            }
                        }
                        // Also check descendants cleanly using querySelectorAll scoped to this node
                        scanRoot(el, onNewItem);
                    }
                });
                shouldFullScan = true;
            }
        }

        if (shouldFullScan) debouncedFullScan();
    });

    observer.observe(document.body, { childList: true, subtree: true });

    // Initial scan
    scanRoot(document, onNewItem);
}

function processNode(el: HTMLElement, strategy: PlatformStrategy, callback: (item: ScannedItem) => void) {
    // 1. Deduplication by ID
    const uniqueId = strategy.getUniqueId(el);
    // We removed the processedIds check here to support virtualization.

    // 2. Check if already processed by DOM marker (fastest check)
    if (el.dataset.lucidProcessed) return;

    // 3. Nested Container Check (Fix for Double Blur)
    // Only skip if a PARENT element was already processed by Lucid.
    // We cannot use generic selectors like 'article' because Instagram
    // feed posts ARE articles — that would silently drop valid items.
    if (el.parentElement?.closest('[data-lucid-processed]')) {
        return;
    }

    // 3b. Exclusion Check (e.g. Forward Dialog)
    if (strategy.shouldExclude && strategy.shouldExclude(el)) {
        el.dataset.lucidProcessed = 'true'; // Mark as ignored to prevent re-scanning
        return;
    }

    // 4. Wait condition (e.g. waiting for video to load)
    if (strategy.shouldWait(el)) {
        return;
    }

    const video = strategy.getVideo(el);
    const thumbnail = strategy.getThumbnail(el);

    // 5. Final safety check: need at least video or thumbnail
    if (!video && !thumbnail) {
        return;
    }

    // Mark as processed
    el.dataset.lucidProcessed = 'true';

    const item: ScannedItem = {
        id: uniqueId || crypto.randomUUID(),
        platform: strategy.name,
        container: el,
        video: video,
        thumbnail: thumbnail,
        caption: strategy.getCaption(el),
        author: strategy.getAuthor(el),
        uiConfig: strategy.uiConfig
    };

    logger.debug(`Extracted: ${strategy.name} ID: ${item.id.substring(0, 20)}...`);

    callback(item);
}
