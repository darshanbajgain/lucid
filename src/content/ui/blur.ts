import { logger } from "../../utils/logger";
import { recordReveal as analyticsRecordReveal } from "../analytics/engine";
import { sessionEngine } from "../engine/session";
import type { InterventionLevel } from "../engine/session";

/**
 * Blur Overlay — Three-Level Intervention (v2.2.2: timers removed)
 *
 * Score-driven, no reveal-count escalation, no reflection prompts, no
 * off-ramps. Three levels, each with one job and an instant escape hatch.
 *
 *   null → ALLOW: no overlay rendered
 *   1    → 12 px blur · one-line reason · instant Reveal
 *   2    → 18 px blur · headline + score        · instant Reveal
 *   3    → 24 px blur · headline ("Blocked" or "Daily limit reached")
 *           · instant Reveal · cooldown line if daily-limit
 *
 * Countdown rings were removed (v2.2.2) — they pushed users to wait rather
 * than reflect, and looked particularly heavy on TikTok's full-screen
 * single-video view. The blur itself is the friction; the Reveal button
 * is the escape hatch.
 *
 * Style: minimal text, no emojis. The card is the message.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CARD_STYLE = `
    padding: 16px;
    background: rgba(0,0,0,0.65);
    border-radius: 12px;
    border: 1px solid rgba(255,255,255,0.12);
    max-width: 82%;
`.trim();

const REVEAL_BTN_STYLE = `
    background: rgba(255,255,255,0.18);
    border: 1px solid rgba(255,255,255,0.25);
    color: white;
    padding: 6px 14px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 12px;
    pointer-events: auto;
    transition: opacity 0.2s ease;
    width: 100%;
`.trim();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function applyBlur(
    container: HTMLElement,
    level: InterventionLevel | null,
    // v2.2.2: score + reasons are no longer rendered in the overlay (kept
    // in the signature for compatibility with the verdict-log call sites).
    _score: number,
    _reasons: string[],
    uiConfig?: {
        overlayZIndex?: string;
        forceRelative?: boolean;
        customClass?: string;
    },
    /**
     * Optional overlay headline. v2.2 multimodal passes per-source label
     * ('Distractive caption' / 'NSFW content detected' / 'Distractive + NSFW
     * flagged'). When omitted, the level-default headline is used.
     */
    headlineLabel?: string,
    /**
     * Which signal produced this blur ('image' | 'blocklist' | ...). Stamped
     * onto the container as `data-lucid-source` so settings-change handlers
     * (e.g. removing a blocklist term) can find and re-evaluate the posts a
     * given signal blurred. Omitted on unblur (level === null), which clears it.
     */
    source?: string,
): void {
    const existingOverlays = container.querySelectorAll(".lucid-blur-overlay");
    if (existingOverlays.length > 0) {
        existingOverlays.forEach((o) => o.remove());
        logger.debug(`Removed ${existingOverlays.length} existing overlay(s)`);
    }

    if (level === null) {
        // Unblur — clear the source marker so it's no longer a re-eval target.
        delete container.dataset.lucidSource;
        return;
    }

    if (source) container.dataset.lucidSource = source;

    const overlay = document.createElement("div");
    overlay.className = `lucid-blur-overlay ${uiConfig?.customClass || ""}`;
    overlay.dataset.lucidOverlay = "true";
    overlay.dataset.lucidLevel = String(level);

    overlay.style.position = "absolute";
    overlay.style.top = "0";
    overlay.style.left = "0";
    overlay.style.width = "100%";
    overlay.style.height = "100%";
    overlay.style.zIndex = uiConfig?.overlayZIndex || "50";
    overlay.style.display = "flex";
    overlay.style.flexDirection = "column";
    overlay.style.alignItems = "center";
    overlay.style.justifyContent = "center";
    overlay.style.color = "white";
    overlay.style.fontFamily = "system-ui, -apple-system, sans-serif";
    overlay.style.textAlign = "center";
    overlay.style.cursor = "default";

    overlay.addEventListener(
        "click",
        (e) => {
            const target = e.target as HTMLElement;
            if (
                target.dataset.lucidInteractive === "true" ||
                target.closest("[data-lucid-interactive='true']")
            ) {
                return;
            }
            e.preventDefault();
            e.stopPropagation();
        },
        true
    );

    // Per V2_PIVOT_PLAN §6.2: 12 / 18 / 24 px
    const blurAmount = level === 3 ? "24px" : level === 2 ? "18px" : "12px";
    overlay.style.backdropFilter = `blur(${blurAmount})`;
    overlay.style.backgroundColor = "rgba(0, 0, 0, 0.45)";

    const card = document.createElement("div");
    card.style.cssText = CARD_STYLE;
    const blurAppliedAt = Date.now();

    if (level === 1) {
        buildLevel1(card, overlay, blurAppliedAt, headlineLabel);
    } else if (level === 2) {
        buildLevel2(card, overlay, blurAppliedAt, headlineLabel);
    } else {
        buildLevel3(card, overlay, blurAppliedAt, headlineLabel);
    }

    overlay.appendChild(card);

    if (uiConfig?.forceRelative !== false) {
        const computed = window.getComputedStyle(container);
        if (computed.position === "static") {
            container.style.position = "relative";
        }
    }

    container.appendChild(overlay);
}

/**
 * Provisional "pending" blur — applied the instant a Smart-mode post is seen,
 * before the image classifier has run, so nothing flashes unblurred while the
 * inference queue (max 2 concurrent, ~700 ms each) works through a busy feed.
 *
 * Deliberately lightweight vs a real verdict: blur + faint scrim only, no
 * card, no headline, no Reveal button — the user shouldn't act on it yet. If
 * the image comes back clean, the caller removes it (reveal). If it fires,
 * the caller's applyBlur() replaces it (both share the `.lucid-blur-overlay`
 * class, so applyBlur's "remove existing overlays first" handles the swap).
 *
 * Idempotent: skips if any Lucid overlay already exists on the container.
 */
export function applyProvisionalBlur(
    container: HTMLElement,
    uiConfig?: { overlayZIndex?: string; forceRelative?: boolean; customClass?: string },
): void {
    if (container.querySelector('.lucid-blur-overlay')) return;

    const overlay = document.createElement('div');
    overlay.className = `lucid-blur-overlay ${uiConfig?.customClass || ''}`;
    overlay.dataset.lucidOverlay = 'true';
    overlay.dataset.lucidProvisional = 'true';
    overlay.style.position = 'absolute';
    overlay.style.top = '0';
    overlay.style.left = '0';
    overlay.style.width = '100%';
    overlay.style.height = '100%';
    overlay.style.zIndex = uiConfig?.overlayZIndex || '50';
    overlay.style.backdropFilter = 'blur(14px)';
    overlay.style.backgroundColor = 'rgba(0, 0, 0, 0.25)';
    // Swallow clicks while pending so the user can't interact with hidden media.
    overlay.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); }, true);

    if (uiConfig?.forceRelative !== false) {
        const computed = window.getComputedStyle(container);
        if (computed.position === 'static') container.style.position = 'relative';
    }

    container.appendChild(overlay);
}

// ---------------------------------------------------------------------------
// Level 1 — Soft blur, instant reveal
// ---------------------------------------------------------------------------

function buildLevel1(
    card: HTMLElement,
    overlay: HTMLElement,
    blurAppliedAt: number,
    headlineLabel?: string,
): void {
    const headline = headlineLabel || "Distracting content";

    card.innerHTML = `
        <div style="font-weight: 600; font-size: 14px;">${escapeHtml(headline)}</div>
    `;

    const btnGroup = createButtonGroup();
    const revealBtn = createRevealButton();
    btnGroup.appendChild(revealBtn);
    card.appendChild(btnGroup);

    attachRevealHandler(revealBtn, overlay, blurAppliedAt, 1);
}

// ---------------------------------------------------------------------------
// Level 2 — Hard blur, headline only, instant Reveal
// ---------------------------------------------------------------------------

function buildLevel2(
    card: HTMLElement,
    overlay: HTMLElement,
    blurAppliedAt: number,
    headlineLabel?: string,
): void {
    const headline = headlineLabel || "Flagged";

    card.innerHTML = `
        <div style="font-weight: 600; font-size: 14px;">${escapeHtml(headline)}</div>
    `;

    const btnGroup = createButtonGroup();
    const revealBtn = createRevealButton();
    btnGroup.appendChild(revealBtn);
    card.appendChild(btnGroup);

    attachRevealHandler(revealBtn, overlay, blurAppliedAt, 2);
}

// ---------------------------------------------------------------------------
// Level 3 — Block, cooldown timer, no Reveal
// ---------------------------------------------------------------------------

/**
 * L3 — heaviest blur, headline + cooldown line if daily-limit, instant Reveal.
 *
 * Two trigger paths produce L3:
 *   (a) score >= 0.9         — on-device classifier is very confident
 *   (b) daily 90-min limit   — user's cumulative session cap hit
 *
 * The friction is the heavy 24 px blur itself. Countdown was removed in
 * v2.2.2 — users found the wait obtrusive without a corresponding gain
 * in mindfulness. The blur stays sticky (a re-classification never
 * unblurs), so the friction surface is preserved.
 */
function buildLevel3(
    card: HTMLElement,
    overlay: HTMLElement,
    blurAppliedAt: number,
    headlineLabel?: string,
): void {
    const inCooldown = sessionEngine.isInCooldown();
    const headline = inCooldown
        ? "Daily limit reached"
        : (headlineLabel || "Sensitive content");

    card.innerHTML = `
        <div style="font-weight: 700; font-size: 15px;">${escapeHtml(headline)}</div>
        ${inCooldown
            ? `<div style="font-size: 12px; opacity: 0.75; margin-top: 6px; line-height: 1.5;">90 minutes of feed time today.</div>`
            : ""
        }
    `;

    // Cooldown reset line (only when daily limit triggered the L3)
    if (inCooldown) {
        const cooldownDiv = document.createElement("div");
        cooldownDiv.style.cssText = `
            margin-top: 8px;
            font-size: 12px;
            opacity: 0.7;
        `;
        card.appendChild(cooldownDiv);
        updateCooldownDisplay(cooldownDiv);
        const cooldownInterval = setInterval(() => {
            if (!overlay.isConnected) {
                clearInterval(cooldownInterval);
                return;
            }
            updateCooldownDisplay(cooldownDiv);
        }, 1000);
    }

    const btnGroup = createButtonGroup();
    const revealBtn = createRevealButton();
    btnGroup.appendChild(revealBtn);
    card.appendChild(btnGroup);

    attachRevealHandler(revealBtn, overlay, blurAppliedAt, 3);
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function createRevealButton(): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.dataset.lucidInteractive = "true";
    btn.textContent = "Reveal";
    btn.style.cssText = REVEAL_BTN_STYLE;
    return btn;
}

function createButtonGroup(): HTMLDivElement {
    const group = document.createElement("div");
    group.style.cssText = `
        margin-top: 12px;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 6px;
        width: 100%;
    `;
    return group;
}

function attachRevealHandler(
    btn: HTMLButtonElement,
    overlay: HTMLElement,
    blurAppliedAt: number,
    level: InterventionLevel
): void {
    btn.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();

        overlay.remove();

        const latencyMs = Date.now() - blurAppliedAt;
        analyticsRecordReveal(latencyMs);
        sessionEngine.recordReveal();

        logger.debug("Reveal", { level, latencyMs });
    });
}

function updateCooldownDisplay(element: HTMLElement): void {
    const remainingMs = sessionEngine.getCooldownRemainingMs();
    if (remainingMs <= 0) {
        // Cooldown lifted while overlay was open — clear the line.
        element.textContent = "";
        return;
    }

    const hours = Math.floor(remainingMs / 3_600_000);
    const mins = Math.floor((remainingMs % 3_600_000) / 60_000);
    element.textContent = hours > 0
        ? `Resets in ${hours}h ${mins}m`
        : `Resets in ${mins}m`;
}

/** XSS-safe inline-HTML interpolation for overlay text. */
function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]!));
}
