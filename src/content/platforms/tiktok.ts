import { PlatformStrategy } from "../observer";

/**
 * TikTok platform strategy — covers three layouts:
 *
 *   1. For You Page (FYP) feed     → [data-e2e="recommend-list-item-container"]
 *   2. Single video page           → [data-e2e="browse-video"]
 *   3. User profile grid           → [data-e2e="user-post-item"]
 *   4. Explore / discover grid     → [data-e2e="explore-item"]
 *
 * Verified against captured TikTok DOM samples (2026-06-13).
 *
 * Critical layout differences:
 *
 *   FYP            : <video> element present from the start. <picture><img>
 *                    is the poster. [data-e2e="video-desc"] holds the
 *                    caption + hashtag anchors as inline children.
 *
 *   Grid views     : NO <video> element until the user hovers a thumbnail.
 *                    Only <picture><img> is loaded eagerly. There's no
 *                    [data-e2e="video-desc"] either — TikTok bakes the
 *                    full caption into the <img alt="..."> for screen
 *                    readers. The poster <a> wraps a full URL like
 *                    /@<username>/video/<19-digit-id>, which gives us
 *                    both the author and the unique ID for free.
 *
 * Anti-pattern avoided: scoping shouldWait to wait for <video>. That would
 * mean grid items never get scanned (they never grow a video element).
 */

const TT_SELECTORS = {
    FEED_ITEM: '[data-e2e="recommend-list-item-container"]',
    SINGLE_VIDEO: '[data-e2e="browse-video"]',
    USER_GRID: '[data-e2e="user-post-item"]',
    EXPLORE_GRID: '[data-e2e="explore-item"]',
    SEARCH_VIDEO_TAB: '[data-e2e="search_video-item"]',
    SEARCH_TOP_TAB: '[data-e2e="search_top-item"]',
    // Cinema-mode modal: opened when the user clicks a grid item. Contains
    // 3 interaction-layer containers (prev / current / next) so the user
    // can swipe through videos without leaving the modal. Each wraps its
    // own <picture><img> + <video> + xgwrapper-N-<videoId>.
    MODAL_VIDEO: '[data-cinema-mode-player-interaction-layer]',
};

function isGridItem(c: Element): boolean {
    return (
        c.matches(TT_SELECTORS.USER_GRID) ||
        c.matches(TT_SELECTORS.EXPLORE_GRID) ||
        c.matches(TT_SELECTORS.SEARCH_VIDEO_TAB) ||
        c.matches(TT_SELECTORS.SEARCH_TOP_TAB)
    );
}

export const TikTokStrategy: PlatformStrategy = {
    name: 'TikTok',
    selector: Object.values(TT_SELECTORS).join(', '),

    shouldWait: (c) => {
        // Universal: need a real poster image loaded. Works for both FYP
        // (which also has a video) and grids (which don't).
        const img = c.querySelector('picture img') as HTMLImageElement | null;
        if (!img || !img.src) return true;
        // TikTok shows a transparent data: GIF placeholder during hydration.
        if (img.src.startsWith('data:')) return true;

        // FYP additionally needs the <video> to have a src — that's how we
        // distinguish a real card from a still-loading shell. Grids skip
        // this check entirely.
        if (!isGridItem(c)) {
            const video = c.querySelector('video');
            if (!video || !video.src) return true;
        }

        return false;
    },

    shouldExclude: (c) => {
        if (c.querySelector('[data-e2e="video-ad"]')) return true;
        if (c.querySelector('[data-e2e="brand-tag"]')) return true;
        return false;
    },

    getUniqueId: (c) => {
        // Tier 1: xgwrapper-N-<videoId> on FYP player container.
        const xgwrapper = c.querySelector('[id^="xgwrapper-"]');
        if (xgwrapper) {
            const id = xgwrapper.getAttribute('id') || '';
            const match = id.match(/xgwrapper-\d+-(\d+)/);
            if (match) return match[1];
        }

        // Tier 2: /video/<19-digit-id> in any link inside the card.
        // Grid items always have this on the wrapping <a>.
        const videoLink = c.querySelector('a[href*="/video/"]');
        if (videoLink) {
            const href = videoLink.getAttribute('href') || '';
            const match = href.match(/\/video\/(\d+)/);
            if (match) return match[1];
        }

        return null;
    },

    getVideo: (c) => c.querySelector('video'),

    getThumbnail: (c) => {
        // Tier 1: <picture><img> — present in both FYP and grids.
        const pictureImg = c.querySelector('picture img');
        if (pictureImg instanceof HTMLImageElement) return pictureImg;

        // Tier 2: any tiktokcdn-hosted img.
        const imgs = Array.from(c.querySelectorAll('img'));
        const cdnImg = imgs.find(
            (i) =>
                /tiktokcdn(-us)?\.com/.test(i.src) &&
                !/avatar|profile/i.test(i.alt || ''),
        );
        if (cdnImg) return cdnImg;

        // Tier 3: any non-avatar non-tiny img.
        return (
            imgs.find((i) => {
                const alt = (i.alt || '').toLowerCase();
                const isAvatar = alt.includes('avatar') || alt.includes('profile');
                const tooSmall =
                    (i.width > 0 && i.width < 100) || (i.height > 0 && i.height < 100);
                return !isAvatar && !tooSmall;
            }) || null
        );
    },

    getCaption: (c) => {
        let captionText = '';

        // FYP: [data-e2e="video-desc"] is the canonical caption container.
        // textContent walks the inline <span> + <a> children to return
        // "<title> #tag1 #tag2 ..." in one pass.
        const desc =
            c.querySelector('[data-e2e="video-desc"]') ||
            c.querySelector('[data-e2e="browse-video-desc"]') ||
            c.querySelector('[data-e2e="search-card-video-caption"]');
        if (desc) captionText = (desc.textContent || '').trim();

        // Grid views (user profile, explore): no video-desc element. The
        // full caption + hashtag list lives in the <img alt="..."> on the
        // poster. TikTok writes it there for screen readers — it's an
        // accurate, complete copy of what FYP would show.
        if (!captionText) {
            const pictureImg = c.querySelector('picture img');
            const altText = (pictureImg?.getAttribute('alt') || '').trim();
            if (altText.length >= 3) captionText = altText;
        }

        // Hashtag anchors — `/tag/<name>` is the URL pattern. We recover
        // these as a safety net even when captionText already includes
        // them, since the desc textContent doesn't always include the `#`
        // prefix consistently.
        const tagAnchors = c.querySelectorAll('a[href^="/tag/"]');
        const tagTexts: string[] = [];
        const seenTags = new Set<string>();
        for (const a of Array.from(tagAnchors)) {
            const raw = (a.textContent || '').trim();
            const tag = raw.startsWith('#') ? raw : `#${raw}`;
            if (tag.length > 1 && !captionText.includes(tag) && !seenTags.has(tag)) {
                tagTexts.push(tag);
                seenTags.add(tag);
            }
        }

        // @-mentions inside the caption — exclude the post-header author
        // link and the avatar link so we don't double-count the creator.
        const creatorInfo = c.querySelector('[class*="DivCreatorInfoContainer"]');
        const authorAvatar = c.querySelector('[data-e2e="video-author-avatar"]');
        const mentionAnchors = c.querySelectorAll('a[href^="/@"]');
        const mentionTexts: string[] = [];
        const seenMentions = new Set<string>();
        for (const a of Array.from(mentionAnchors)) {
            if (creatorInfo?.contains(a)) continue;
            if (authorAvatar?.contains(a)) continue;
            if (a === authorAvatar) continue;
            const raw = (a.textContent || '').trim();
            const mention = raw.startsWith('@') ? raw : `@${raw}`;
            if (
                mention.length > 1 &&
                !captionText.includes(mention) &&
                !seenMentions.has(mention)
            ) {
                mentionTexts.push(mention);
                seenMentions.add(mention);
            }
        }

        const parts = [captionText, ...tagTexts, ...mentionTexts].filter(Boolean);
        const combined = parts.join(' ').trim();
        return combined || null;
    },

    getAuthor: (c) => {
        // Tier 1 (FYP): username <p> inside the creator-info link block.
        const creatorLink = c.querySelector(
            '[class*="DivCreatorInfoContainer"] a[href^="/@"]',
        );
        if (creatorLink) {
            const p = creatorLink.querySelector('p');
            const text = (p?.textContent || creatorLink.textContent || '').trim();
            if (text.length > 0 && text.length < 50) return text;
        }

        // Tier 2 (FYP): strip /@<user> from the avatar link href.
        const avatarLink = c.querySelector('[data-e2e="video-author-avatar"]');
        if (avatarLink) {
            const href = avatarLink.getAttribute('href') || '';
            const match = href.match(/^\/@([^/]+)/);
            if (match) return match[1];
        }

        // Tier 3 (Grids): every grid item wraps a link of the form
        // https://www.tiktok.com/@<user>/video/<id>. Parse the username.
        const videoLink = c.querySelector('a[href*="/video/"]');
        if (videoLink) {
            const href = videoLink.getAttribute('href') || '';
            const match = href.match(/@([^/]+)\/video\//);
            if (match) return match[1];
        }

        return null;
    },

    uiConfig: {
        overlayZIndex: '9999',
        forceRelative: true,
    },
};
