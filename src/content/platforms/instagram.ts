import { PlatformStrategy } from "../observer";

const IG_SELECTORS = {
    FEED: 'article',
    MODAL: 'div[role="dialog"]:not([aria-label="Share"])',
    DM_ITEM: 'div.x1qjc9v5[role="button"]',
    REELS_TAB: 'div.x1qjc9v5.xg7h5cd',
    GRID_ITEM: 'div._aagu'
};

export const InstagramStrategy: PlatformStrategy = {
    name: 'Instagram',
    // Define selectors for different sections for better maintainability
    selector: Object.values(IG_SELECTORS).join(', '),
    shouldWait: (c) => {
        // If it looks like a Reel (has reel link), wait for video with a valid source.
        const isReel = !!c.querySelector('a[href*="/reel/"]') || c.classList.contains('x1qjc9v5');
        const video = c.querySelector('video');

        // Optimisation: If we already have a high-res image, we can probably proceed
        // This fixes the "glimpse" issue on Photo posts that might share the 'x1qjc9v5' class but never load a video.
        const images = Array.from(c.querySelectorAll('img'));
        const hasLargeImage = images.some(img => img.width > 200 && img.height > 200 && !img.alt.includes('profile picture'));

        if (hasLargeImage) return false;

        // DM Support: If it's a shared Clip/Post in DM (indicated by Clip icon), we shouldn't wait for a video.
        // DMs often just show a thumbnail.
        const isDMClip = !!c.querySelector('svg[aria-label="Clip"]');
        const isGridItem = c.classList.contains('_aagu');

        if (isReel && !isDMClip && !isGridItem && (!video || !video.src)) return true;
        return false;
    },
    shouldExclude: (c) => {
        // Exclude "Forward" / "Share" dialogs (Omnipicker)
        // They often have role="dialog" but contain a specific header or aria-label.
        const omnipicker = c.querySelector('[aria-label="title text for omnipicker"]');
        if (omnipicker) return true;

        const header = c.querySelector('h1, h2, h3');
        if (header) {
            const text = header.textContent || '';
            if (text.includes('Forward') || text.includes('Share to') || text.includes('Viewers')) {
                return true;
            }
        }
        return false;
    },
    getUniqueId: (c) => {
        // Priority 1: Canonical link
        let link = c.querySelector('a[href*="/reel/"]') || c.querySelector('a[href*="/p/"]');

        // Handle Grid Item: The container IS inside the link, or the link is the parent.
        if (!link && c.classList.contains('_aagu')) {
            link = c.closest('a');
        }

        if (link) {
            const href = link.getAttribute('href');
            return href ? href.split('?')[0] : null;
        }
        // Priority 2: Data instance key (common in Reels tab)
        const instanceKeyEl = c.querySelector('[data-instancekey]');
        if (instanceKeyEl) {
            return instanceKeyEl.getAttribute('data-instancekey');
        }
        // Priority 3: Try to extract ID from thumbnail src (Fallback for DMs)
        const img = c.querySelector('img');
        if (img && img.src) {
            // Heuristic: Instagram IDs are often long numeric strings in the URL
            const match = img.src.match(/\/(\d+)_/);
            if (match) return match[1];
        }
        return null;
    },
    getVideo: (c) => c.querySelector('video'),
    getThumbnail: (c) => {
        const images = Array.from(c.querySelectorAll('img'));
        // Find first image that is NOT a profile picture or user avatar
        // Also ignore small icons/avatars by size check (e.g. < 50px)
        return images.find(img => {
            const alt = img.alt.toLowerCase();
            const isProfile = alt.includes('profile picture') || alt.includes('user avatar');
            const isSmall = (img.width > 0 && img.width < 100) || (img.height > 0 && img.height < 100);
            return !isProfile && !isSmall;
        }) || images[0] || null;
    },
    getCaption: (c) => {
        // Step 1 — extract caption text. Strategy: collect candidate spans
        // from multiple tiers (modern _aacu, legacy _aacl, modal h1, generic
        // dir="auto") and pick the LONGEST text content across all of them.
        //
        // Why "longest wins" instead of first match: IG sometimes renders the
        // caption title in one _aacu span and the body in a SIBLING _aacu span
        // (not nested). querySelector('span._aacu') returns the title only,
        // missing the body. Picking the longest text across all candidates
        // handles all known layouts: nested-spans, sibling title+body spans,
        // single-span captions, and layout changes that move text to other
        // classes.
        let captionText = '';

        const considerText = (text: string): void => {
            if (text.length > captionText.length) captionText = text;
        };

        // Tier 1: all _aacu spans (modern IG, 2024+)
        for (const span of Array.from(c.querySelectorAll('span._aacu'))) {
            considerText((span.textContent || '').trim());
        }

        // Tier 2: all _aacl spans (legacy IG, pre-2024)
        for (const span of Array.from(c.querySelectorAll('span._aacl'))) {
            considerText((span.textContent || '').trim());
        }

        // Tier 3: h1 in single-post modal
        const h1 = c.querySelector('h1');
        if (h1) considerText((h1.textContent || '').trim());

        // Tier 4: heuristic fallback — longest dir="auto" span with
        // whitespace, BUT only if tiers 1-3 found nothing. IG comments are
        // also dir="auto" and frequently longer than the caption (especially
        // on reels with short / no caption). Without the gate, the
        // "longest wins" rule above would treat the top comment as the
        // caption and feed it to the blocklist + verdict log.
        //
        // Tier 4 still exists as a defensive net for layout changes that
        // rename _aacu / _aacl without breaking dir="auto" — but only when
        // the structured tiers genuinely returned nothing.
        if (!captionText) {
            for (const span of Array.from(c.querySelectorAll('span[dir="auto"]'))) {
                const text = (span.textContent || '').trim();
                if (text.length >= 20 && /\s/.test(text)) {
                    considerText(text);
                }
            }
        }

        // Step 2 — strip Instagram's "... more" UI truncation indicator.
        // IG renders this when a caption is too long for the feed view. The
        // suffix appears as "... more" or "…more" (with the unicode ellipsis).
        captionText = captionText
            .replace(/[….]{1,}\s*more\s*$/i, '')
            .replace(/[….]{1,}\s*$/i, '')
            .trim();

        // Step 3 — explicitly collect hashtag link text from the article DOM.
        // IG keeps hashtag <a> elements in the DOM even when the caption is
        // visually truncated. This recovers the hashtags we'd otherwise miss
        // due to the truncation. Same for @-mentions.
        const tagAnchors = c.querySelectorAll('a[href*="/explore/tags/"]');
        const tagTexts: string[] = [];
        for (const a of Array.from(tagAnchors)) {
            const text = (a.textContent || '').trim();
            if (text.startsWith('#') && !captionText.includes(text)) {
                tagTexts.push(text);
            }
        }

        // @-mentions — links inside _aacu spans that point to a user profile.
        // We scope to _aacu spans rather than the entire article to avoid
        // picking up the post-header username anchor.
        const mentionTexts: string[] = [];
        const seenMentions = new Set<string>();
        for (const aacu of Array.from(c.querySelectorAll('span._aacu'))) {
            const mentionAnchors = aacu.querySelectorAll('a[href^="/"]:not([href*="/explore/tags/"])');
            for (const a of Array.from(mentionAnchors)) {
                const text = (a.textContent || '').trim();
                if (text.startsWith('@') && !captionText.includes(text) && !seenMentions.has(text)) {
                    mentionTexts.push(text);
                    seenMentions.add(text);
                }
            }
        }

        // Step 4 — combine the recovered tags + mentions with the caption text.
        const parts = [captionText, ...tagTexts, ...mentionTexts].filter(Boolean);
        const combined = parts.join(' ').trim();
        return combined || null;
    },
    getAuthor: (c) => {
        // Modern IG: username text lives in span._aacw
        const aacw = c.querySelector('span._aacw');
        if (aacw) {
            const text = (aacw.textContent || '').trim();
            if (text.length > 0 && text.length < 50) return text;
        }

        // Legacy / Reels selectors
        const reelsLink = c.querySelector('a[href*="/reels/"]:not([href*="/audio/"])')
            || c.querySelector('div.x14z9mp a');
        if (reelsLink) {
            const text = reelsLink.textContent?.trim();
            if (text && text.length > 0 && text.length < 50) return text;
        }

        // Fallback: first profile-shaped link (/username/ with no other segments)
        const links = c.querySelectorAll('a[href^="/"][href$="/"]');
        for (const link of Array.from(links)) {
            const href = link.getAttribute('href') || '';
            if (/^\/[^/]+\/$/.test(href) && !/^\/(p|reel|reels|explore|stories|audio)\//.test(href)) {
                const text = (link.textContent || '').trim();
                if (text.length > 0 && text.length < 50) return text;
            }
        }

        return null;
    },
    expandCaption: (c) => {
        // IG keeps caption body + hashtags out of the feed-view DOM until the
        // user clicks the "... more" button. We click it programmatically so
        // the watcher can pick up the injected text and re-analyze.
        //
        // Target shape (modern IG feed):
        //   <span>...&nbsp;<div role="button">more</div></span>
        //
        // The kebab "More options" button has aria-label but its textContent
        // is empty (SVG only), so matching textContent === "more" only hits
        // the caption-expand button.
        const buttons = c.querySelectorAll('div[role="button"]');
        for (const btn of Array.from(buttons)) {
            const text = (btn.textContent || '').trim().toLowerCase();
            if (text === 'more' || text === '… more' || text === '... more') {
                (btn as HTMLElement).click();
                return true;
            }
        }
        return false;
    },
    uiConfig: {
        overlayZIndex: '9999',
        forceRelative: true
    }
};
