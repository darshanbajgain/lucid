# Developer Guide

How to build, run, debug, and extend Lucid. For the *why* behind the runtime
shape, read [`ARCHITECTURE.md`](ARCHITECTURE.md) first.

---

## Prerequisites

- Node 18+ and npm
- Chrome (or any Chromium browser) with Developer mode

## Build & load

```bash
npm install
npm run build          # tsc + vite → dist/
```

Then in Chrome:

1. `chrome://extensions`
2. Enable **Developer mode** (top-right)
3. **Load unpacked** → select `dist/`
4. Open Instagram or TikTok; click the Lucid icon for the popup

`npm run dev` runs Vite with HMR for the **popup** only; content-script /
background changes require `npm run build` + a reload of the unpacked
extension (the ↻ icon on the extensions page) and a page refresh.

> `npm run build` runs `tsc` first, so a type error fails the build. There is
> no unit-test runner wired up — verification is manual (see below).

---

## Project structure (orientation)

```
src/
├─ background/     service worker (routing) + offscreen doc (ONNX inference)
├─ content/        per-tab content script
│  ├─ platforms/   Instagram + TikTok DOM strategies
│  ├─ engine/      scorer (decision), blocklist, session, strictness (modes)
│  ├─ pipeline/    two-stage orchestrator (Stage 1 text, Stage 2 image)
│  ├─ cache/       L1/L2 result cache
│  └─ ui/          blur overlay + timer pill
└─ popup/          React popup (mode picker + blocklist editor)
```

The full module map + invariants are in [`ARCHITECTURE.md`](ARCHITECTURE.md).

---

## Debugging

Lucid logs **one concise line per rendered post** — the always-on verdict:

```
[Lucid] BLUR L2 · explicit=0.86 gore=0.00 neutral=0.03 suggestive=0.11 · @user "caption…"
```

- Seen in the **page console** (DevTools on Instagram/TikTok → switch the
  console context dropdown from `top` to **Lucid**, then filter on `[Lucid]`).
- Image decisions print the four class scores; blocklist decisions print the
  matched terms.

All the pipeline plumbing logs (SW routing, offscreen fetch/inference, bridge)
go through `logger.debug`, which is **stripped from production builds** and only
appears in `npm run dev`. Errors always surface.

**Model / inference logs** live in the offscreen + service-worker consoles:
`chrome://extensions` → Lucid → **Inspect views** → offscreen / service worker.
The first Smart-mode scan downloads the model once (`model: downloading from
CDN`), then hits the Cache API.

---

## Common changes

| Task | Where |
|------|-------|
| **Add a platform** | New `src/content/platforms/<name>.ts` implementing `PlatformStrategy`; register in `src/content/observer.ts` `STRATEGIES`; add host to `manifest.json` `matches` + `host_permissions` |
| **Add a blocklist category** | `DEFAULT_CATEGORIES` in `src/content/engine/blocklist.ts` (popup picks it up automatically). Ship new categories **default-off** |
| **Tune blur thresholds** | `IMAGE_THRESHOLDS` in `src/content/engine/scorer.ts` (per-mode, per-class) |
| **Add/rename an image class** | `NsfwClass` in `src/content/analyzers/worker/protocol.ts` **and** `CLASS_ORDER` in `src/background/offscreen.ts` — order is alphabetical and **must** match the model's output index |
| **Ship a new model** | Update `MODEL_URL` + bump `MODEL_CACHE_NAME` in `src/background/model-loader.ts`; bump `CACHE_VERSION` in `src/content/cache/result-cache.ts` to invalidate old verdicts |

⚠️ **Class-order invariant.** The model outputs logits in **alphabetical class
order**. `CLASS_ORDER` and `NsfwClass` must reflect that exact order, or every
prediction is silently mislabeled. When changing classes, retrain and verify the
first `[Lucid]` inference line shows sane per-class scores.

---

## Shipping a model update

1. Train + export (see [`../training/README.md`](../training/README.md)).
2. Publish the `.onnx` to the public model host (+ model card).
3. Point `MODEL_URL` at the new asset, bump `MODEL_CACHE_NAME` (`v3` → `v4`).
4. Bump `CACHE_VERSION` so cached 3-/4-class verdicts are recomputed.
5. `npm run build`, reload, and confirm the new scores in the offscreen console.

---

## Manual verification checklist

No automated tests — verify by scrolling a real feed in **Smart** mode:

- Ordinary posts **reveal** (no over-blurring); NSFW/graphic posts **blur**.
- The `[Lucid]` line shows four sane scores; the predicted class matches the
  image.
- Blocklist: add a custom term, confirm matching posts blur with `Blocked term`.
- Toggle **Off / Basic / Smart** and confirm the image model only runs in Smart.
- Reload with a cleared cache (bump `CACHE_VERSION` or clear storage) and confirm
  the model re-downloads once, then serves from cache.
