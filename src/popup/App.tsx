import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import type { ClassifierMode } from '../content/engine/strictness';
import { useChromeStorageState } from './hooks/useChromeStorageState';
import { BlocklistEditor } from './components/BlocklistEditor';

const MODE_KEY = 'lucid_classifier_mode';
const TIMER_PILL_KEY = 'lucid_show_timer_pill';
const DEFAULT_MODE: ClassifierMode = 'smart';
const DAILY_LIMIT_MIN = 90;

// Footer links → the repo's PRIVACY.md / SUPPORT.md (on the default branch).
const PRIVACY_URL = 'https://github.com/darshanbajgain/lucid/blob/main/PRIVACY.md';
const SUPPORT_URL = 'https://github.com/darshanbajgain/lucid/blob/main/SUPPORT.md';

function getUtcDateKey(): string {
    const now = new Date();
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, '0');
    const d = String(now.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

const dateKey = getUtcDateKey();
const DAILY_MINUTES_KEY = `lucid_feed_minutes_${dateKey}`;
const DAILY_LOG_KEY = `dailyLog_${dateKey}`;

interface ModeOption {
    value: ClassifierMode;
    label: string;
    description: string;
    badge?: string;
    icon: ReactNode;
}

// Off (inert) / Basic (keywords only) / Smart (image model + keywords).
const MODE_OPTIONS: readonly ModeOption[] = [
    {
        value: 'off',
        label: 'Off',
        description: 'No filtering - nothing is blurred.',
        icon: <IconPower />,
    },
    {
        value: 'basic',
        label: 'Basic',
        description: 'Hashtag & keyword filter only. Blurs posts whose caption matches your blocklist - no image analysis, near-zero CPU.',
        icon: <IconFilter />,
    },
    {
        value: 'smart',
        label: 'Smart',
        description: 'On-device AI scans each thumbnail and blurs explicit, suggestive, gore & graphic violence - plus your hashtag blocklist.',
        icon: <IconSparkles />,
    },
] as const;

function migrateMode(raw: unknown): ClassifierMode {
    if (raw === 'off' || raw === 'basic' || raw === 'smart') return raw;
    if (raw === 'strict' || raw === 'light' || raw === 'low' || raw === 'balanced') return 'smart';
    if (raw === 'lite') return 'off';
    return DEFAULT_MODE;
}

function sessionTone(minutes: number): 'ok' | 'amber' | 'red' {
    if (minutes >= DAILY_LIMIT_MIN) return 'red';
    if (minutes >= DAILY_LIMIT_MIN / 2) return 'amber';
    return 'ok';
}

type View = 'main' | 'settings';

export function App() {
    const [rawMode, setRawMode] = useChromeStorageState<unknown>(MODE_KEY, DEFAULT_MODE);
    const mode = migrateMode(rawMode);

    const [showTimerPillRaw, setShowTimerPillRaw] = useChromeStorageState<unknown>(
        TIMER_PILL_KEY,
        true,
    );
    const showTimerPill = showTimerPillRaw !== false;

    const [dailyMinutesRaw] = useChromeStorageState<unknown>(DAILY_MINUTES_KEY, 0);
    const dailyMinutes = Math.floor(typeof dailyMinutesRaw === 'number' ? dailyMinutesRaw : 0);

    const [view, setView] = useState<View>('main');
    const [, setResetNonce] = useState(0);
    const [confirmingResetAll, setConfirmingResetAll] = useState(false);

    const handleResetToday = useCallback(async () => {
        await chrome.storage.local.remove([DAILY_LOG_KEY, DAILY_MINUTES_KEY]);
        try {
            await chrome.storage.session.remove('lucid_session');
        } catch {
            /* not always available */
        }
        setResetNonce((n) => n + 1);
    }, []);

    const handleResetAllConfirmed = useCallback(async () => {
        const all = await chrome.storage.local.get(null);
        const toRemove = Object.keys(all).filter(
            (k) => k.startsWith('lucid_') || k.startsWith('dailyLog_'),
        );
        if (toRemove.length > 0) await chrome.storage.local.remove(toRemove);
        try {
            await chrome.storage.session.clear();
        } catch {
            /* ignore */
        }
        setRawMode(DEFAULT_MODE);
        setShowTimerPillRaw(true);
        setResetNonce((n) => n + 1);
        setConfirmingResetAll(false);
        setView('main');
    }, [setRawMode, setShowTimerPillRaw]);

    return (
        <div className="relative flex min-h-[380px] flex-col bg-surface font-sans text-on-surface">
            {view === 'main' ? (
                <MainView mode={mode} setMode={setRawMode} onOpenSettings={() => setView('settings')} />
            ) : (
                <SettingsView
                    onBack={() => setView('main')}
                    dailyMinutes={dailyMinutes}
                    showTimerPill={showTimerPill}
                    onToggleTimerPill={setShowTimerPillRaw}
                    onResetToday={handleResetToday}
                    onResetAll={() => setConfirmingResetAll(true)}
                />
            )}

            <footer className="mt-auto px-4 pb-4 pt-3 text-center">
                <p className="text-[11px]">
                    <span className="font-semibold text-primary">Lucid v1.2</span>
                    <span className="text-on-surface-variant"> · On-device processing</span>
                </p>
                <div className="mt-1 flex justify-center gap-4 text-[11px] text-on-surface-variant">
                    <a
                        href={PRIVACY_URL}
                        target="_blank"
                        rel="noreferrer"
                        className="transition-colors hover:text-primary"
                    >
                        Privacy
                    </a>
                    <a
                        href={SUPPORT_URL}
                        target="_blank"
                        rel="noreferrer"
                        className="transition-colors hover:text-primary"
                    >
                        Support
                    </a>
                </div>
            </footer>

            {confirmingResetAll && (
                <ResetOverlay
                    onCancel={() => setConfirmingResetAll(false)}
                    onConfirm={handleResetAllConfirmed}
                />
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Main view — protection level + blocklist
// ---------------------------------------------------------------------------

function MainView({
    mode,
    setMode,
    onOpenSettings,
}: {
    mode: ClassifierMode;
    setMode: (m: ClassifierMode) => void;
    onOpenSettings: () => void;
}) {
    return (
        <>
            <header className="flex items-center justify-between border-b border-outline-variant px-4 py-3">
                <div className="flex items-center gap-2.5">
                    <LucidLogo />
                    <div className="leading-tight">
                        <h1 className="font-display text-[19px] font-bold tracking-tight text-primary">
                            Lucid
                        </h1>
                        <p className="text-[11px] text-on-surface-variant">A clearer feed</p>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    <span className="rounded-full bg-surface-container px-2 py-1 font-mono text-[10px] font-medium tracking-wider text-on-surface-variant">
                        On-device
                    </span>
                    <button
                        type="button"
                        onClick={onOpenSettings}
                        aria-label="Settings"
                        className="rounded-full p-1.5 text-on-surface-variant transition-colors hover:bg-surface-container active:scale-95"
                    >
                        <IconGear />
                    </button>
                </div>
            </header>

            <main className="flex flex-col gap-5 px-4 py-4">
                <section aria-labelledby="mode-label">
                    <SectionLabel id="mode-label">Protection level</SectionLabel>
                    <div
                        className="mt-2.5 flex flex-col gap-2.5"
                        role="radiogroup"
                        aria-labelledby="mode-label"
                    >
                        {MODE_OPTIONS.map((opt) => {
                            const checked = mode === opt.value;
                            return (
                                <label
                                    key={opt.value}
                                    className={[
                                        'group relative flex cursor-pointer items-start gap-3 rounded-xl border p-4 transition-colors',
                                        checked
                                            ? 'border-primary bg-primary-fixed ring-1 ring-primary'
                                            : 'border-outline-variant bg-surface-low hover:border-outline',
                                    ].join(' ')}
                                >
                                    <input
                                        type="radio"
                                        name="mode"
                                        value={opt.value}
                                        checked={checked}
                                        onChange={() => setMode(opt.value)}
                                        className="sr-only"
                                    />
                                    <span
                                        className={[
                                            'mt-0.5 shrink-0',
                                            checked ? 'text-primary' : 'text-on-surface-variant',
                                        ].join(' ')}
                                    >
                                        {opt.icon}
                                    </span>
                                    <div className="flex flex-1 flex-col gap-1 pr-5">
                                        <span
                                            className={[
                                                'font-display text-[15px] font-bold',
                                                checked ? 'text-primary' : 'text-on-surface',
                                            ].join(' ')}
                                        >
                                            {opt.label}
                                        </span>
                                        <span
                                            className={[
                                                'text-[12px] leading-snug',
                                                checked
                                                    ? 'text-on-surface'
                                                    : 'text-on-surface-variant',
                                            ].join(' ')}
                                        >
                                            {opt.description}
                                        </span>
                                    </div>
                                    {checked && (
                                        <span className="absolute right-3.5 top-3.5 text-primary">
                                            <IconCheckCircle />
                                        </span>
                                    )}
                                </label>
                            );
                        })}
                    </div>
                </section>

                <BlocklistEditor />
            </main>
        </>
    );
}

// ---------------------------------------------------------------------------
// Settings view — session stats, preferences, data actions
// ---------------------------------------------------------------------------

function SettingsView({
    onBack,
    dailyMinutes,
    showTimerPill,
    onToggleTimerPill,
    onResetToday,
    onResetAll,
}: {
    onBack: () => void;
    dailyMinutes: number;
    showTimerPill: boolean;
    onToggleTimerPill: (v: boolean) => void;
    onResetToday: () => void;
    onResetAll: () => void;
}) {
    const tone = sessionTone(dailyMinutes);
    const progressPct = Math.min(100, (dailyMinutes / DAILY_LIMIT_MIN) * 100);
    const progressColor =
        tone === 'red' ? 'bg-rose-500' : tone === 'amber' ? 'bg-amber-500' : 'bg-primary';
    const minutesTextColor =
        tone === 'red' ? 'text-rose-600' : tone === 'amber' ? 'text-amber-700' : 'text-on-surface';

    return (
        <>
            <header className="flex items-center gap-2 border-b border-outline-variant px-3 py-3">
                <button
                    type="button"
                    onClick={onBack}
                    aria-label="Back"
                    className="rounded-full p-1.5 text-on-surface-variant transition-colors hover:bg-surface-container active:scale-95"
                >
                    <IconArrowLeft />
                </button>
                <h1 className="font-display text-[17px] font-bold tracking-tight text-on-surface">
                    Settings
                </h1>
            </header>

            <main className="flex flex-col gap-5 px-4 py-4">
                <section>
                    <SectionLabel>Session</SectionLabel>
                    <div className="mt-2.5 rounded-xl border border-outline-variant bg-surface-lowest p-4">
                        <div className="mb-2 flex items-baseline justify-between">
                            <span className={`font-display text-base font-bold ${minutesTextColor}`}>
                                {dailyMinutes} min today
                            </span>
                            <span className="text-[11px] text-on-surface-variant">
                                of {DAILY_LIMIT_MIN}-min limit
                            </span>
                        </div>
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-variant">
                            <div
                                className={`h-full rounded-full transition-all ${progressColor}`}
                                style={{ width: `${progressPct}%` }}
                            />
                        </div>
                        {tone === 'red' && (
                            <p className="mt-2 text-[11px] font-medium text-rose-600">
                                Daily limit reached.
                            </p>
                        )}
                    </div>
                </section>

                <section>
                    <SectionLabel>Preferences</SectionLabel>
                    <label className="mt-2.5 flex cursor-pointer items-center justify-between gap-3 rounded-xl border border-outline-variant bg-surface-lowest px-4 py-3">
                        <span className="flex flex-col">
                            <span className="text-[13px] font-medium text-on-surface">
                                Show session timer pill
                            </span>
                            <span className="text-[11px] text-on-surface-variant">
                                A small on-feed badge with your time today.
                            </span>
                        </span>
                        <Toggle checked={showTimerPill} onChange={onToggleTimerPill} />
                    </label>
                </section>

                <section>
                    <SectionLabel>Data</SectionLabel>
                    <div className="mt-2.5 flex flex-col gap-2">
                        <button
                            type="button"
                            onClick={onResetToday}
                            className="w-full rounded-lg border border-outline-variant bg-surface-lowest px-3 py-2.5 text-[13px] font-semibold text-on-surface transition-colors hover:bg-surface-container active:bg-surface-variant"
                        >
                            Reset today's stats
                        </button>
                        <button
                            type="button"
                            onClick={onResetAll}
                            className="w-full rounded-lg border border-rose-200 bg-rose-50 px-3 py-2.5 text-[13px] font-semibold text-rose-600 transition-colors hover:bg-rose-100 active:bg-rose-200"
                        >
                            Reset everything
                        </button>
                    </div>
                </section>
            </main>
        </>
    );
}

// ---------------------------------------------------------------------------
// Reset-all confirmation — modal overlay on top of the whole popup
// ---------------------------------------------------------------------------

function ResetOverlay({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-5"
            role="dialog"
            aria-modal="true"
            aria-label="Reset everything"
            onClick={onCancel}
        >
            <div
                className="w-full rounded-xl border border-outline-variant bg-surface-lowest p-4 shadow-xl"
                onClick={(e) => e.stopPropagation()}
            >
                <p className="font-display text-base font-bold text-on-surface">Reset everything?</p>
                <p className="mt-1 text-[12px] leading-snug text-on-surface-variant">
                    Wipes mode, blocklist, settings, and today's data. This can't be undone.
                </p>
                <div className="mt-3.5 flex gap-2">
                    <button
                        type="button"
                        onClick={onCancel}
                        className="flex-1 rounded-lg border border-outline-variant bg-surface-lowest px-3 py-2 text-xs font-semibold text-on-surface transition-colors hover:bg-surface-container"
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        onClick={onConfirm}
                        className="flex-1 rounded-lg border border-rose-600 bg-rose-600 px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-rose-700 active:bg-rose-800"
                    >
                        Yes, reset
                    </button>
                </div>
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Small presentational helpers
// ---------------------------------------------------------------------------

function SectionLabel({ id, children }: { id?: string; children: ReactNode }) {
    return (
        <h2
            id={id}
            className="font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-outline"
        >
            {children}
        </h2>
    );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
    return (
        <span className="relative inline-flex h-5 w-9 shrink-0 items-center">
            <input
                type="checkbox"
                checked={checked}
                onChange={(e) => onChange(e.target.checked)}
                className="peer sr-only"
            />
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
        </span>
    );
}

// ---------------------------------------------------------------------------
// Inline SVG icons (CSP blocks external assets — everything is inlined)
// ---------------------------------------------------------------------------

function LucidLogo() {
    // Matches public/logo.svg + the toolbar icon — a lens (clarity) + sparkle mark.
    return (
        <svg
            width="32"
            height="32"
            viewBox="0 0 128 128"
            fill="none"
            aria-hidden="true"
            className="shadow-sm"
            style={{ borderRadius: 8 }}
        >
            <defs>
                <linearGradient
                    id="lucidGradHeader"
                    x1="8"
                    y1="8"
                    x2="120"
                    y2="120"
                    gradientUnits="userSpaceOnUse"
                >
                    <stop stopColor="#5A5CF0" />
                    <stop offset="1" stopColor="#2F2EBE" />
                </linearGradient>
            </defs>
            <rect width="128" height="128" rx="30" fill="url(#lucidGradHeader)" />
            <circle cx="59" cy="67" r="30" stroke="#fff" strokeWidth="7" strokeOpacity="0.5" />
            <circle cx="59" cy="67" r="14" fill="#fff" />
            <path
                d="M97 24l3.8 9.9 9.9 3.8-9.9 3.8L97 51.4l-3.8-9.9-9.9-3.8 9.9-3.8L97 24z"
                fill="#fff"
            />
        </svg>
    );
}

function IconPower() {
    return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
                d="M12 3v9M7.5 6.5a8 8 0 109 0"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    );
}

function IconFilter() {
    return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
                d="M3 5h18l-7 8v6l-4-2v-4L3 5z"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    );
}

function IconSparkles() {
    return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
                d="M12 3l1.8 4.7L18.5 9.5 13.8 11.3 12 16l-1.8-4.7L5.5 9.5l4.7-1.8L12 3zM18.5 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8.8-2z"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinejoin="round"
                fill="currentColor"
                fillOpacity="0.15"
            />
        </svg>
    );
}

function IconCheckCircle() {
    return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.7" />
            <path
                d="M8 12.5l2.5 2.5L16 9.5"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    );
}

function IconGear() {
    return (
        <svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.7" />
            <path
                d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-2.9 1.09V21a2 2 0 11-4 0v-.09A1.65 1.65 0 007 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.65 1.65 0 004.6 14a1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 8a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06A1.65 1.65 0 009 3.6 1.65 1.65 0 0010 2.09V2a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06A1.65 1.65 0 0019.4 9c.28.63.9 1.02 1.6 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    );
}

function IconArrowLeft() {
    return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
                d="M15 18l-6-6 6-6"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    );
}
