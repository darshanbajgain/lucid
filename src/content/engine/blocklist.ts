/**
 * User-controlled hashtag + phrase blocklist.
 *
 * Replaces the v2.2.3 disabled heuristic text analyzer with a transparent,
 * user-driven filter. Defaults ship in four categories; the user can toggle
 * whole categories on/off in the popup and add their own custom terms.
 *
 * Why this design:
 *   - Heuristic keyword lists (the old text.ts) had a high false-positive
 *     rate and the user had no recourse — words triggered blurs they
 *     didn't choose.
 *   - User-curated terms invert that: every blur is the result of an
 *     explicit user decision. No model bias to manage, no calibration.
 *   - Categorised defaults are a starting point, not a baked-in rule. The
 *     user can switch off an entire category they don't care about.
 *
 * Matching is case-insensitive substring against the lowercased caption
 * text (which already includes recovered hashtag anchors per platform
 * strategy). Substring beats word-boundary here because we want
 * "#nudism" → blocked if "nude" is on the list.
 */

function isExtensionContextValid(): boolean {
    try {
        return !!chrome.runtime?.id;
    } catch {
        return false;
    }
}

// ---------------------------------------------------------------------------
// Categories + defaults
// ---------------------------------------------------------------------------

export type BlocklistCategory = 'nsfw' | 'viral' | 'engagementBait' | 'distracting';

interface CategoryEntry {
    readonly key: BlocklistCategory;
    readonly label: string;
    readonly description: string;
    readonly terms: readonly string[];
}

export const DEFAULT_CATEGORIES: readonly CategoryEntry[] = [
    {
        key: 'nsfw',
        label: 'NSFW',
        description: 'Explicit and suggestive hashtags and phrases.',
        terms: [
            '#nsfw', '#nude', '#nudity', '#sexy', '#lingerie',
            '#thirsttrap', '#thirst', '#onlyfans', '#explicit',
        ],
    },
    {
        key: 'viral',
        label: 'Viral / algorithm bait',
        description: 'Generic discoverability tags posts use to game the feed.',
        terms: [
            '#fyp', '#foryou', '#foryoupage', '#explore', '#explorepage',
            '#reels', '#viral', '#trending',
        ],
    },
    {
        key: 'engagementBait',
        label: 'Engagement bait',
        description: 'Phrases that ask for a follow / DM / tag to drive interaction.',
        terms: [
            'link in bio', 'dm for', 'dm me', 'giveaway', 'promote',
            'tag a friend', 'follow for more', 'comment below',
        ],
    },
    {
        key: 'distracting',
        label: 'Distracting topics',
        description: 'Drama, gossip, politics, financial bait, hustle culture.',
        terms: [
            'drama', 'gossip', 'politics', 'celebrity', 'news',
            'billionaire', 'grindset', 'manifestation', 'get rich',
        ],
    },
] as const;

// ---------------------------------------------------------------------------
// Storage shape
// ---------------------------------------------------------------------------

export interface BlocklistSettings {
    /** Per-category enable flags. */
    readonly categories: Readonly<Record<BlocklistCategory, boolean>>;
    /** User-added terms, stored verbatim, lowercased on match. */
    readonly custom: readonly string[];
    /** Settings-schema version, for one-time default migrations. */
    readonly v?: number;
}

const STORAGE_KEY = 'lucid_blocklist';

// Bump when we want to force a default change onto existing installs.
//   1 (implicit) — original all-categories-on default
//   2 — calm default: only NSFW on; viral / engagement / distracting off
//   3 — everything off by default; the keyword blocklist is fully opt-in
const SETTINGS_VERSION = 3;

// Nothing is enabled by default. The categories are curated term lists the
// user can opt into — even NSFW keyword tags over-fire on ordinary posts
// (and the image model already handles explicit/gore/suggestive imagery in
// Smart mode). The keyword blocklist is a tool the user reaches for, not a
// default filter: they add their own terms and switch on the lists they want.
const DEFAULT_SETTINGS: BlocklistSettings = {
    categories: {
        nsfw: false,
        viral: false,
        engagementBait: false,
        distracting: false,
    },
    custom: [],
};

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

export async function loadBlocklistSettings(): Promise<BlocklistSettings> {
    if (!isExtensionContextValid()) return DEFAULT_SETTINGS;
    try {
        const r = await chrome.storage.local.get(STORAGE_KEY);
        const stored = r[STORAGE_KEY] as Partial<BlocklistSettings> | undefined;
        if (!stored) return DEFAULT_SETTINGS;

        let categories = { ...DEFAULT_SETTINGS.categories, ...(stored.categories ?? {}) };
        const custom = Array.isArray(stored.custom) ? stored.custom : [];

        // One-time migration to the v3 "all opt-in" default — force every
        // category off for pre-v3 installs. Runs once, then the stamped
        // version prevents re-triggering, so later user toggles are respected.
        // Custom terms are always preserved.
        if ((stored.v ?? 1) < SETTINGS_VERSION) {
            categories = { nsfw: false, viral: false, engagementBait: false, distracting: false };
            const migrated: BlocklistSettings = { categories, custom, v: SETTINGS_VERSION };
            void saveBlocklistSettings(migrated);
            return migrated;
        }

        return { categories, custom, v: stored.v };
    } catch {
        return DEFAULT_SETTINGS;
    }
}

export async function saveBlocklistSettings(settings: BlocklistSettings): Promise<void> {
    if (!isExtensionContextValid()) return;
    // Always stamp the current version so a save (e.g. a user toggle in the
    // popup) doesn't leave the settings looking pre-migration and re-trigger
    // the one-time default migration on the next load.
    await chrome.storage.local.set({ [STORAGE_KEY]: { ...settings, v: SETTINGS_VERSION } });
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

export interface BlocklistMatch {
    fires: boolean;
    matched: string[];
}

/**
 * Build the active terms list — concat enabled categories + custom terms.
 * Lowercased once here so the hot matching loop is plain substring.
 */
export function activeTerms(settings: BlocklistSettings): string[] {
    const out: string[] = [];
    for (const cat of DEFAULT_CATEGORIES) {
        if (settings.categories[cat.key]) {
            for (const t of cat.terms) out.push(t.toLowerCase());
        }
    }
    for (const t of settings.custom) {
        const lc = t.toLowerCase().trim();
        if (lc) out.push(lc);
    }
    return out;
}

/**
 * Check a caption against the active blocklist. Returns the matched terms
 * (verdict log surfaces these so the user knows WHY a post fired).
 */
export function checkBlocklist(caption: string | null, terms: string[]): BlocklistMatch {
    if (!caption || terms.length === 0) return { fires: false, matched: [] };
    const lc = caption.toLowerCase();
    const matched: string[] = [];
    for (const term of terms) {
        if (lc.includes(term)) matched.push(term);
    }
    return { fires: matched.length > 0, matched };
}
