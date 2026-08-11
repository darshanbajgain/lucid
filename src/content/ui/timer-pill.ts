import { sessionEngine } from "../engine/session";
import { logger } from "../../utils/logger";

/**
 * Session Timer Pill
 *
 * A small fixed-position badge at the bottom-right of the feed that
 * shows cumulative minutes-on-feed today. Opt-in via the
 * `lucid_show_timer_pill` storage key (default: true).
 *
 * Thresholds:
 *   <  15 min  → hidden
 *   15–45 min  → shown in white
 *   45–90 min  → amber (you're past the halfway point)
 *   >= 90 min  → red (daily cooldown has triggered)
 *
 * No modal, no blocking — just passive visibility. The L3 cooldown
 * (which actually changes pipeline behaviour) is rendered separately
 * via blur.ts when a flagged item appears.
 */

const STORAGE_KEY_ENABLED = "lucid_show_timer_pill";
const PILL_ID = "lucid-timer-pill";

// Show as soon as the pill is enabled (from 0 min) so the popup toggle gives
// immediate, visible feedback. The amber/red thresholds still provide the nudge.
const SHOW_AT_MINUTES = 0;
const AMBER_AT_MINUTES = 45;
const RED_AT_MINUTES = 90;
const TICK_MS = 60_000;

let pill: HTMLDivElement | null = null;
let updateInterval: ReturnType<typeof setInterval> | null = null;

async function isEnabled(): Promise<boolean> {
    try {
        const r = await chrome.storage.local.get(STORAGE_KEY_ENABLED);
        // Default to true when key is missing
        return r[STORAGE_KEY_ENABLED] !== false;
    } catch {
        return true;
    }
}

function ensurePill(): HTMLDivElement {
    if (pill && pill.isConnected) return pill;
    pill = document.createElement("div");
    pill.id = PILL_ID;
    // Marked so observer.ts ignores our own DOM nodes
    pill.dataset.lucidInteractive = "true";
    pill.style.cssText = `
        position: fixed;
        bottom: 16px;
        right: 16px;
        z-index: 9999;
        background: rgba(0,0,0,0.7);
        color: white;
        padding: 6px 12px;
        border-radius: 999px;
        font-family: system-ui, -apple-system, sans-serif;
        font-size: 12px;
        font-weight: 600;
        pointer-events: none;
        opacity: 0;
        transition: opacity 0.3s ease, color 0.3s ease, border-color 0.3s ease;
        border: 1px solid rgba(255,255,255,0.15);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        white-space: nowrap;
    `;
    document.body.appendChild(pill);
    return pill;
}

function update(): void {
    if (!pill) return;
    const minutes = Math.floor(sessionEngine.getState().dailyMinutesOnFeed);

    if (minutes < SHOW_AT_MINUTES) {
        pill.style.opacity = "0";
        return;
    }

    pill.textContent = `${minutes} min today`;
    pill.style.opacity = "1";

    if (minutes >= RED_AT_MINUTES) {
        pill.style.color = "rgb(255, 120, 120)";
        pill.style.borderColor = "rgba(255, 120, 120, 0.4)";
    } else if (minutes >= AMBER_AT_MINUTES) {
        pill.style.color = "rgb(255, 200, 100)";
        pill.style.borderColor = "rgba(255, 200, 100, 0.4)";
    } else {
        pill.style.color = "white";
        pill.style.borderColor = "rgba(255, 255, 255, 0.15)";
    }
}

function teardown(): void {
    if (updateInterval) {
        clearInterval(updateInterval);
        updateInterval = null;
    }
    pill?.remove();
    pill = null;
}

function startTicker(): void {
    if (updateInterval) return;
    updateInterval = setInterval(update, TICK_MS);
}

let storageListenerWired = false;

export async function mountTimerPill(): Promise<void> {
    // Live toggle — install once, even if the pill is currently disabled,
    // so re-enabling from the popup brings it back without a reload.
    if (!storageListenerWired) {
        storageListenerWired = true;
        try {
            chrome.storage.local.onChanged.addListener((changes) => {
                const change = changes[STORAGE_KEY_ENABLED];
                if (!change) return;
                if (change.newValue === false) {
                    teardown();
                } else {
                    ensurePill();
                    update();
                    startTicker();
                }
            });
        } catch (e) {
            logger.warn("TimerPill: storage.onChanged unavailable", e);
        }
    }

    if (!(await isEnabled())) return;

    ensurePill();
    update();
    startTicker();
}
