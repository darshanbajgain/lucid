# Architecture

> Single source of truth for Lucid's runtime shape. If you're planning an architecture-level change, start here. For user-facing behaviour read the [README](../README.md); for the model and how it was trained see the [model card](https://huggingface.co/darshan12222/lucid-nsfw-4class) and [`TRAINING.md`](https://huggingface.co/darshan12222/lucid-nsfw-4class/blob/main/TRAINING.md).
>
> **Version covered:** v1.2 (Off / Basic / Smart modes; 4-class model — explicit / gore / neutral / suggestive, v1.2.0; blocklist + image, no heuristic text path).
> **Last reviewed:** 2026-10-11.

---

## 1. Process model

Chrome MV3 splits the extension across three execution contexts. Lucid uses all three:

```text
┌─────────────────────────────────────────────────────────────┐
│  Content script (per-tab)                                   │
│  src/content/                                               │
│  ─────────────                                              │
│  • Runs in the page's main world (subject to page CSP)      │
│  • Observes DOM, extracts captions + thumbnails             │
│  • Owns the per-post pipeline + blur overlay                │
│  • L1 in-memory cache (per tab)                             │
└─────────────────────────────────────────────────────────────┘
                       │
                       │ chrome.runtime.sendMessage
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  Service worker (background)                                │
│  src/background/index.ts                                    │
│  ─────────────────                                          │
│  • Persistent across tabs, restarted by Chrome on idle      │
│  • Routes ANALYZE_NSFW / PING / SCRAPE_RECORD               │
│  • Lazy-creates the offscreen document on first request     │
│  • Holds L2 persistent cache (chrome.storage.local)         │
└─────────────────────────────────────────────────────────────┘
                       │
                       │ chrome.runtime messages
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  Offscreen document                                         │
│  src/background/offscreen.ts                                │
│  ─────────────────────────                                  │
│  • DOM + WebGL context, no CSP restrictions                 │
│  • Loads ONNX model from Cache API (or fetches from HF)     │
│  • Runs onnxruntime-web inference per request               │
│  • Returns 4-class probs (explicit/gore/neutral/suggestive) │
└─────────────────────────────────────────────────────────────┘
```

**Why the three-process split?** MV3 service workers can't run WASM with `eval`, can't hold DOM, and may be terminated mid-inference. The offscreen document gives us a full DOM context that survives long enough for ONNX inference. The service worker is the routing layer because content scripts can't talk to the offscreen document directly — they go through the worker.

**Lazy offscreen creation.** The first `ANALYZE_NSFW` request triggers `chrome.offscreen.createDocument(...)`. We mutex-guard this because two parallel posts on first scan would otherwise race-create two documents. After creation it stays alive across the session; Chrome may reclaim it on long idle.

---

## 2. Decision pipeline

Two signals, one decision rule. Either signal can fire. The combiner sits in [`src/content/engine/scorer.ts`](../src/content/engine/scorer.ts).

```text
                       ScannedItem (caption, thumbnail, video, ...)
                                       │
                                       ▼
                ┌──────────────────────┴─────────────────────┐
                │                                            │
                ▼                                            ▼
       Stage 1 (~1 ms)                            Stage 2 (~700 ms)
       runStage1()                                 runStage2()
       ─────────────                              ─────────────
       blocklist match                            image classifier
       on caption                                 on thumbnail
       (Basic + Smart)                            (Smart only)
                │                                            │
                └──────────────────┬─────────────────────────┘
                                   ▼
                          combineDecision(
                            imageScores,
                            mode,
                            blocklistMatch,
                          )
                                   │
                                   ▼
                  ┌────────────────┴────────────────┐
                  │                                 │
              source = 'image'                  source = 'blocklist'
              label = 'Sensitive content'       label = 'Blocked term'
              priority when both fire           fires when blocklist matched
                                                only and image didn't
                                                or didn't run
```

**Source priority (when both fire):** `image > blocklist`. Image is the more specific signal — a thumbnail matching the classifier's "explicit" or "suggestive" class is a stronger statement than a caption containing `#fyp`.

**Mode gating (Off / Basic / Smart).** The mode is a text-vs-AI axis, not a strictness dial:

- **Off** — fully inert (neither signal runs)
- **Basic** — blocklist only (keywords/hashtags), no image model
- **Smart** *(default)* — image model (blurs explicit + suggestive) **plus** the blocklist; a superset of Basic

`modeUsesImage()` returns true only for Smart. `combineDecision` gates `blocklistFires` on `mode !== 'off'`. Smart blurs every image class it detects — there's no explicit-only tier (the old Smart/Strict split was collapsed in v1.1).

**Sticky-blur invariant.** Once Stage 1 fires (blocklist match), the blur is applied immediately and never unblurred even if Stage 2 disagrees. This avoids the "blur flickers off after 700 ms" UX failure that the original multimodal design would produce on borderline cases.

---

## 3. Platform strategy interface

Per-platform DOM logic is isolated behind a single interface in [`src/content/observer.ts`](../src/content/observer.ts):

```ts
interface PlatformStrategy {
    name: 'Instagram' | 'TikTok';  // extend the union to add a platform
    selector: string;              // CSS selector for the post container
    shouldWait?(c): boolean;       // true while still hydrating
    shouldExclude?(c): boolean;    // true to skip permanently (e.g. ads)
    getUniqueId(c): string | null;
    getVideo(c): HTMLVideoElement | null;
    getThumbnail(c): HTMLImageElement | null;
    getCaption(c): string | null;
    getAuthor(c): string | null;
    expandCaption?(c): boolean;    // IG-specific: click "more"
    uiConfig?: { overlayZIndex?: string; forceRelative?: boolean };
}
```

Strategies registered in `STRATEGIES` array. The observer dispatches each container to the matching strategy via hostname (see §4).

**Adding a third platform** = one new file + one line in the registry + entries in `manifest.json` for `matches` and `host_permissions`. No changes to the pipeline, scorer, blur, or cache.

### Hostname gating

The naive design — let every strategy try every container — broke when TikTok's `<article data-e2e="...">` matched Instagram's `<article>` selector. Now `strategyMatchesHost(strategy, host)` filters strategies before the observer dispatches:

```ts
function strategyMatchesHost(strategy, host) {
    if (strategy.name === 'Instagram') return host.includes('instagram.com');
    if (strategy.name === 'TikTok')    return host.includes('tiktok.com');
    return true;
}
```

When extending to a third platform, add a clause here.

---

## 4. Storage layers

| Layer | Where | Purpose | Lifetime |
|---|---|---|---|
| **Settings** | `chrome.storage.local` | Mode (`lucid_classifier_mode`), blocklist (`lucid_blocklist`), timer-pill toggle, daily-minute counters | Permanent until user clears |
| **Session state** | `chrome.storage.session` | `lucid_session` — current-session stats | Until browser restart |
| **L1 verdict cache** | In-memory `Map` in content script | Hot path for same-post re-scans | Until tab navigation |
| **L2 verdict cache** | `chrome.storage.local` (`rc_*` keys) | Cross-tab + cross-session persistence | 7 days, evicted on read |
| **Model cache** | Cache API (`lucid-models-v4`) | ONNX bytes after first fetch from Hugging Face | Until cache name bump or user clear |

**Cache versioning.** `CACHE_VERSION` in [`result-cache.ts`](../src/content/cache/result-cache.ts) is bumped when verdict shape or the model changes; older entries fail validation and get evicted. Currently `v8` (v1.2.0 4-class model).

**Model cache versioning.** `MODEL_CACHE_NAME` in [`model-loader.ts`](../src/background/model-loader.ts) is bumped when shipping a new model. Browser garbage-collects old caches by name.

**Live update from popup → content script.** Both contexts share `chrome.storage.local`. The pipeline's `chrome.storage.onChanged` listener invalidates cached settings/blocklist on edit, so popup changes take effect on the next scan with no reload.

---

## 5. Module layout

```text
src/
├─ background/
│  ├─ index.ts             Service worker — message router, offscreen mutex
│  ├─ model-loader.ts      Cache API + Hugging Face fetch (no bundled fallback)
│  ├─ offscreen.ts         ONNX inference (loads model once, reuses session)
│  └─ scrape-store.ts      Optional: training-data collection mode
│
├─ content/
│  ├─ index.ts             Entry point. Wires observer → pipeline → blur.
│  │                       Owns: L1 cache, modal-URL watcher, verdict log.
│  │                       Hosts the extension-context invalidation guard.
│  ├─ observer.ts          MutationObserver + STRATEGIES + hostname gate.
│  ├─ platforms/
│  │  ├─ instagram.ts      IG strategy: feed, modal, reels, profile grids, DMs.
│  │  │                    Includes "... more" caption expansion.
│  │  └─ tiktok.ts         TT strategy: FYP, single video, profile grid,
│  │                       explore grid, search Top + Videos, cinema-mode modal.
│  ├─ engine/
│  │  ├─ blocklist.ts      DEFAULT_CATEGORIES + storage helpers + matching.
│  │  ├─ scorer.ts         combineDecision (image + blocklist).
│  │  ├─ session.ts        Daily-minute counter, L1/L2/L3 level mapping.
│  │  └─ strictness.ts     Mode storage + legacy value migration.
│  ├─ pipeline/
│  │  ├─ analyze.ts        runStage1 + runStage2 orchestration + caching.
│  │  └─ on-device-classify.ts  Thin proxy from content → background.
│  ├─ analyzers/
│  │  └─ worker/
│  │     ├─ index.ts       Bridge: content script → background message API.
│  │     ├─ protocol.ts    Shared message types (DecisionSource, etc.)
│  │     └─ vision-worker.ts  Pure function called from background context.
│  ├─ cache/
│  │  └─ result-cache.ts   L2 persistent verdict cache (chrome.storage.local).
│  ├─ analytics/
│  │  └─ engine.ts         Daily metrics: scanned/blocked/revealed/inference-ms.
│  ├─ ui/
│  │  ├─ blur.ts           Three-level blur overlay with instant Reveal.
│  │  └─ timer-pill.ts     Floating daily-minute pill on feeds.
│  └─ scrape/
│     └─ recorder.ts       Training-data collection mode (off by default).
│
└─ popup/
   ├─ main.tsx             React DOM root.
   ├─ App.tsx              Mode picker + BlocklistEditor + Stats panel.
   ├─ components/
   │  └─ BlocklistEditor.tsx  Categorised toggles + custom term editor.
   └─ hooks/
      └─ useChromeStorageState.ts  Mirror of chrome.storage.local in React.
```

---

## 6. Invariants worth not breaking

These are the design constraints that took iterations to discover. Pre-flight them when planning changes:

1. **Sticky-blur.** Stage 2 may upgrade or relabel but never unblurs what Stage 1 set. Code in [`content/index.ts`](../src/content/index.ts) `runPipeline`.

2. **Strategy hostname gate.** Without it, IG's `selector: 'article'` hijacks TikTok's `<article data-e2e>`. See `strategyMatchesHost` in [`observer.ts`](../src/content/observer.ts).

3. **L1 cache uses the in-memory `Map`, L2 uses `chrome.storage.local`.** Same key (post ID) → same verdict. Cache versioning lives in [`result-cache.ts`](../src/content/cache/result-cache.ts).

4. **Mode gating: Off = inert, Basic = blocklist only, Smart = image + blocklist.** Logic in [`scorer.ts`](../src/content/engine/scorer.ts) `combineDecision` (`mode !== 'off'` gates the blocklist; `modeUsesImage` is Smart-only). Smart blurs all image classes — no explicit-only tier.

5. **`isExtensionContextValid()` guard.** Content scripts orphaned after extension reload throw "Extension context invalidated" on every `chrome.runtime` call. Module-level handlers in [`content/index.ts`](../src/content/index.ts) suppress the noise + helpers check before storage writes.

6. **Captions are dirty.** Each platform strategy enriches the raw text with hashtag anchors + @-mentions found elsewhere in the DOM. The blocklist + verdict log run on the enriched text. Don't bypass `getCaption()`.

7. **Model bytes path: Cache API → CDN (no bundled fallback).** [`model-loader.ts`](../src/background/model-loader.ts). The model lives on a public Hugging Face repo; first successful load caches it forever. If you change the URL, bump `MODEL_CACHE_NAME` too. (The bundled `public/*.onnx` fallback was removed once the remote path was proven.)

8. **CSS overlay z-index 9999, scoped by `data-lucid-overlay`.** TikTok modal handling uses `body[data-lucid-tt-modal="true"]` to suppress grid overlays bleeding through the backdrop while keeping modal-internal overlays visible. See `injectLucidStyles` and `watchTikTokModalUrl` in [`content/index.ts`](../src/content/index.ts).

---

## 7. Where to make common changes

| Want to change... | Touch this |
|---|---|
| Image classifier thresholds | `IMAGE_THRESHOLDS` in [`engine/scorer.ts`](../src/content/engine/scorer.ts) |
| Default blocklist categories or terms | `DEFAULT_CATEGORIES` in [`engine/blocklist.ts`](../src/content/engine/blocklist.ts) |
| Add a new platform | New file in `src/content/platforms/`; register in `observer.ts` `STRATEGIES`; add to `manifest.json` `matches` and `host_permissions`; extend hostname gate |
| Swap to a different ONNX model | Upload to the Hugging Face model repo; update `MODEL_URL` + bump `MODEL_CACHE_NAME` in [`model-loader.ts`](../src/background/model-loader.ts) |
| Add a new blur level (L4?) | `InterventionLevel` in [`engine/session.ts`](../src/content/engine/session.ts), `getLevel` thresholds, new `buildLevelN()` in [`ui/blur.ts`](../src/content/ui/blur.ts) |
| Add a new popup setting | Use `useChromeStorageState(key, default)` in [`App.tsx`](../src/popup/App.tsx); add live-sync invalidation in `pipeline/analyze.ts` if the content script reads it |
| Re-enable heuristic text scoring | Resurrect the file from `git log -p -- src/content/analyzers/text.ts`; add `combineDecision` parameter for `textFires`; wire into `runStage1` |
| Add a third signal (audio, etc.) | New analyzer module; new param on `combineDecision`; update source/label priority |

---

## 8. What's deliberately out of scope

- **Service-side rules.** No backend, no API key, no rate limit. Anything cross-user lives in the offline training pipeline (see [`TRAINING.md`](https://huggingface.co/darshan12222/lucid-nsfw-4class/blob/main/TRAINING.md)), not the runtime.
- **Per-account customisation that requires login.** The extension is anonymous; no account, no sync. Per-machine settings only.
- **Live model updates without a release.** Model URL is hardcoded; updates require a new release tag + extension rebuild. Justified for reproducibility and avoiding silent model swaps.

---

## See also

- [Model card](https://huggingface.co/darshan12222/lucid-nsfw-4class) — classes, metrics, intended use, limitations
- [`TRAINING.md`](https://huggingface.co/darshan12222/lucid-nsfw-4class/blob/main/TRAINING.md) — training data summary + the Colab fine-tune pipeline
- [README](../README.md) — user-facing overview
