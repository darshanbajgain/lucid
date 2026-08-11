/**
 * Classifier Mode — Lucid v1.1 (Off / Basic / Smart)
 *
 *   off    → fully inert: no image model, no keyword blocklist
 *   basic  → keyword/blocklist only (hashtags + phrases); no image model,
 *            near-zero CPU
 *   smart  → on-device image classifier (blurs explicit + suggestive) PLUS
 *            the keyword blocklist. Default. (gore joins here if added later.)
 *
 * The axis is "text-only vs full AI", not "how strict". Smart is a superset
 * of Basic. The old Smart/Strict split is collapsed — turning on the image
 * model means full sensitive-content coverage.
 *
 * Threshold values live in `engine/scorer.ts` (IMAGE_THRESHOLDS). This
 * module is storage glue.
 *
 * Legacy mode-value migration (silent, in migrateMode):
 *   'strict'                              → 'smart'  (Smart now covers both classes)
 *   'light' / 'low' / 'balanced'         → 'smart'
 *   'lite'                               → 'off'
 *   'cloud' / 'offline'                  → 'smart'
 *   'safety' / 'mindful' / 'research'    → 'smart'
 */

export type ClassifierMode = 'off' | 'basic' | 'smart';

export interface StrictnessConfig {
    readonly mode: ClassifierMode;
}

const MODE_KEY = 'lucid_classifier_mode';
const DEFAULT_MODE: ClassifierMode = 'smart';

export function migrateMode(raw: unknown): ClassifierMode {
    if (raw === 'off' || raw === 'basic' || raw === 'smart') return raw;
    // v1.1: Smart/Strict collapsed into Smart (blurs all image classes).
    if (raw === 'strict') return 'smart';
    if (raw === 'light' || raw === 'low' || raw === 'balanced') return 'smart';
    if (raw === 'lite') return 'off';
    if (raw === 'cloud' || raw === 'offline') return 'smart';
    if (raw === 'safety' || raw === 'mindful' || raw === 'research') return 'smart';
    return DEFAULT_MODE;
}

export async function loadStrictnessConfig(): Promise<StrictnessConfig> {
    try {
        const r = await chrome.storage.local.get(MODE_KEY);
        const mode = migrateMode(r[MODE_KEY]);

        // Persist migrated value if it changed
        if (r[MODE_KEY] !== mode) {
            void chrome.storage.local.set({ [MODE_KEY]: mode });
        }

        return { mode };
    } catch {
        return { mode: DEFAULT_MODE };
    }
}

export async function setClassifierMode(mode: ClassifierMode): Promise<void> {
    await chrome.storage.local.set({ [MODE_KEY]: mode });
}
