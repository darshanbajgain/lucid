import { useCallback, useEffect, useState } from 'react';
import {
    DEFAULT_CATEGORIES,
    loadBlocklistSettings,
    saveBlocklistSettings,
} from '../../content/engine/blocklist';
import type { BlocklistCategory, BlocklistSettings } from '../../content/engine/blocklist';

/**
 * Blocklist editor. Fully opt-in: the "add your own term" field comes first
 * (Custom blocklist), then the curated Category lists — all off by default.
 * Each category expands to show its (read-only) terms.
 *
 * Storage lives in chrome.storage.local under `lucid_blocklist`. The content
 * script caches it and the popup updates it; the storage onChanged hook in
 * pipeline/analyze.ts invalidates the cache so updates take effect on the
 * next scan, no extension reload required.
 */

const STORAGE_KEY = 'lucid_blocklist';

export function BlocklistEditor() {
    const [settings, setSettings] = useState<BlocklistSettings | null>(null);
    const [expanded, setExpanded] = useState<BlocklistCategory | null>(null);
    const [customInput, setCustomInput] = useState('');

    useEffect(() => {
        let cancelled = false;
        loadBlocklistSettings().then((s) => {
            if (!cancelled) setSettings(s);
        });

        const listener = (
            changes: Record<string, chrome.storage.StorageChange>,
            area: string,
        ): void => {
            if (area !== 'local' || !changes[STORAGE_KEY]) return;
            const next = changes[STORAGE_KEY].newValue as BlocklistSettings | undefined;
            if (next) setSettings(next);
        };
        chrome.storage.onChanged.addListener(listener);
        return () => {
            cancelled = true;
            chrome.storage.onChanged.removeListener(listener);
        };
    }, []);

    const persist = useCallback((next: BlocklistSettings) => {
        setSettings(next);
        void saveBlocklistSettings(next);
    }, []);

    const toggleCategory = useCallback(
        (key: BlocklistCategory) => {
            if (!settings) return;
            persist({
                ...settings,
                categories: { ...settings.categories, [key]: !settings.categories[key] },
            });
        },
        [settings, persist],
    );

    const addCustom = useCallback(() => {
        if (!settings) return;
        const v = customInput.trim();
        if (!v) return;
        if (settings.custom.includes(v)) {
            setCustomInput('');
            return;
        }
        persist({ ...settings, custom: [...settings.custom, v] });
        setCustomInput('');
    }, [customInput, settings, persist]);

    const removeCustom = useCallback(
        (term: string) => {
            if (!settings) return;
            persist({ ...settings, custom: settings.custom.filter((t) => t !== term) });
        },
        [settings, persist],
    );

    if (!settings) {
        return (
            <section>
                <SectionLabel>Custom blocklist</SectionLabel>
                <p className="mt-2 text-xs text-on-surface-variant">Loading…</p>
            </section>
        );
    }

    return (
        <div className="flex flex-col gap-5">
            {/* Custom blocklist — the primary, opt-in action */}
            <section>
                <SectionLabel>Custom blocklist</SectionLabel>
                <div className="mt-2.5 flex gap-2">
                    <div className="relative flex-1">
                        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-outline">
                            <IconPlus />
                        </span>
                        <input
                            type="text"
                            value={customInput}
                            onChange={(e) => setCustomInput(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                    e.preventDefault();
                                    addCustom();
                                }
                            }}
                            placeholder="add hashtag or phrase to block…"
                            className="w-full rounded-lg border border-outline-variant bg-surface-low py-2.5 pl-9 pr-3 text-[13px] text-on-surface placeholder:text-outline focus:border-primary focus:bg-surface-lowest focus:outline-none focus:ring-2 focus:ring-primary/20"
                        />
                    </div>
                    <button
                        type="button"
                        onClick={addCustom}
                        disabled={!customInput.trim()}
                        className="rounded-lg bg-primary px-4 text-[13px] font-semibold text-on-primary transition-colors hover:bg-on-primary-fixed-variant active:bg-on-primary-fixed disabled:bg-surface-variant disabled:text-outline"
                    >
                        Add
                    </button>
                </div>
                {settings.custom.length > 0 && (
                    <div className="mt-2.5 flex flex-wrap gap-2">
                        {settings.custom.map((t) => (
                            <button
                                key={t}
                                type="button"
                                onClick={() => removeCustom(t)}
                                className="group inline-flex items-center gap-1.5 rounded-full bg-surface-container px-3 py-1 text-[12px] text-on-surface-variant transition-colors hover:bg-rose-50 hover:text-rose-700"
                                title="Click to remove"
                            >
                                {t}
                                <IconClose />
                            </button>
                        ))}
                    </div>
                )}
            </section>

            {/* Category lists — curated, all off by default */}
            <section>
                <SectionLabel>Category lists</SectionLabel>
                <div className="mt-2.5 overflow-hidden rounded-xl border border-outline-variant bg-surface-lowest">
                    {DEFAULT_CATEGORIES.map((cat, i) => {
                        const enabled = settings.categories[cat.key];
                        const isOpen = expanded === cat.key;
                        const notLast = i < DEFAULT_CATEGORIES.length - 1;
                        return (
                            <div key={cat.key} className={notLast ? 'border-b border-outline-variant' : ''}>
                                <div className="flex items-center gap-2 p-4">
                                    <button
                                        type="button"
                                        onClick={() => setExpanded(isOpen ? null : cat.key)}
                                        className="flex flex-1 items-center gap-2 text-left"
                                        aria-expanded={isOpen}
                                    >
                                        <div className="flex-1">
                                            <div className="flex items-center gap-2">
                                                <span className="font-display text-[14px] font-bold text-on-surface">
                                                    {cat.label}
                                                </span>
                                                <span className="rounded-full bg-surface-container px-1.5 py-0.5 font-mono text-[10px] text-on-surface-variant">
                                                    {cat.terms.length}
                                                </span>
                                            </div>
                                            <div className="mt-0.5 text-[12px] leading-snug text-on-surface-variant">
                                                {cat.description}
                                            </div>
                                        </div>
                                        <Chevron open={isOpen} />
                                    </button>
                                    <Switch checked={enabled} onChange={() => toggleCategory(cat.key)} />
                                </div>
                                {isOpen && (
                                    <div className="flex flex-wrap gap-1.5 border-t border-outline-variant bg-surface-low px-4 py-3">
                                        {cat.terms.map((t) => (
                                            <span
                                                key={t}
                                                className="rounded-full bg-surface-container px-2 py-0.5 text-[11px] text-on-surface-variant"
                                            >
                                                {t}
                                            </span>
                                        ))}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            </section>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Local presentational helpers
// ---------------------------------------------------------------------------

function SectionLabel({ children }: { children: React.ReactNode }) {
    return (
        <h2 className="font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-outline">
            {children}
        </h2>
    );
}

function Switch({ checked, onChange }: { checked: boolean; onChange: () => void }) {
    return (
        <label className="relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center">
            <input type="checkbox" checked={checked} onChange={onChange} className="peer sr-only" />
            <span className="h-5 w-9 rounded-full bg-outline-variant transition-colors peer-checked:bg-primary" />
            <span className="absolute left-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-white shadow-sm transition-transform peer-checked:translate-x-4">
                {checked && (
                    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                        <path
                            d="M5 12.5l4.5 4.5L19 7"
                            stroke="#6b38d4"
                            strokeWidth="3.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        />
                    </svg>
                )}
            </span>
        </label>
    );
}

function Chevron({ open }: { open: boolean }) {
    return (
        <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
            className={['shrink-0 text-outline-variant transition-transform', open ? 'rotate-180' : ''].join(' ')}
        >
            <path
                d="M6 9l6 6 6-6"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    );
}

function IconPlus() {
    return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
    );
}

function IconClose() {
    return (
        <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
            className="text-outline group-hover:text-rose-500"
        >
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
        </svg>
    );
}
