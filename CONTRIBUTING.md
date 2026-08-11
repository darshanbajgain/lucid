# Contributing to Lucid

Thanks for your interest in improving Lucid! This guide covers everything you
need to set up the project, understand the codebase, make a change, and open a
pull request.

- **How it works / architecture:** [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- **Build / debug / extend reference:** [`docs/DEVELOPER_GUIDE.md`](docs/DEVELOPER_GUIDE.md)
- **Bug reports / questions:** [`SUPPORT.md`](SUPPORT.md)

---

## Ways to contribute

- 🐛 **Bug fixes** — especially blur/reveal glitches and edge cases.
- 🧭 **Platform selectors** — Instagram/TikTok change their DOM often; updating
  the strategies in `src/content/platforms/` is the most common maintenance need.
- ✨ **Features** — new blocklist categories, popup/UX polish, a new platform.
- 📝 **Docs** — clarifications, examples, typo fixes.

Not sure where to start? Open an issue describing what you'd like to do, or look
for `good first issue` labels.

---

## Prerequisites

- **Node 18+** and npm
- **Chrome** (or any Chromium browser) with Developer mode

## Setup

```bash
# 1. Fork the repo on GitHub, then clone your fork
git clone https://github.com/<you>/lucid.git
cd lucid

# 2. Install and build
npm install
npm run build        # runs tsc, then Vite → dist/

# 3. Load it in Chrome
#    chrome://extensions → Developer mode → Load unpacked → select dist/
```

Open Instagram or TikTok and click the Lucid icon. On first use in **Smart**
mode the ~22 MB model downloads once from Hugging Face, then caches.

---

## Development workflow

- `npm run dev` — Vite dev server with HMR for the **popup UI** only.
- `npm run build` — production build to `dist/`. Content-script and background
  changes require a rebuild **plus** a reload of the unpacked extension (the ↻
  icon on `chrome://extensions`) and a page refresh.
- **Type-checking is the gate:** `npm run build` runs `tsc` first, so a type
  error fails the build. There is **no unit-test runner** — verification is
  manual (see below).

Debugging: Lucid logs **one line per rendered post** to the page console (switch
the DevTools console context to **Lucid**, filter on `[Lucid]`). Model/inference
logs live in the offscreen + service-worker consoles (`chrome://extensions →
Lucid → Inspect views`). More in the developer guide.

---

## Project layout (orientation)

```
src/
├─ background/     service worker (routing) + offscreen doc (ONNX inference)
├─ content/        per-tab content script
│  ├─ platforms/   Instagram + TikTok DOM strategies
│  ├─ engine/      scorer (decision), blocklist, session, strictness (modes)
│  ├─ pipeline/    two-stage orchestrator (Stage 1 text, Stage 2 image)
│  ├─ cache/       L1/L2 result cache
│  └─ ui/          blur overlay + timer pill
└─ popup/          React + Tailwind popup (main + settings views)
```

The full module map, invariants, and a "where to make common changes" table are
in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Common changes

| Task | Where |
|------|-------|
| **Add a platform** | New `src/content/platforms/<name>.ts` implementing `PlatformStrategy`; register in `src/content/observer.ts`; add the host to `manifest.json` `matches` + `host_permissions` |
| **Add a blocklist category** | `DEFAULT_CATEGORIES` in `src/content/engine/blocklist.ts` — ship it **default-off** |
| **Tune blur thresholds** | `IMAGE_THRESHOLDS` in `src/content/engine/scorer.ts` |
| **Ship a new model** | `MODEL_URL` + `MODEL_CACHE_NAME` in `src/background/model-loader.ts`; bump `CACHE_VERSION` in `src/content/cache/result-cache.ts` |

> ⚠️ **Class-order invariant.** The model outputs logits in **alphabetical class
> order** (`explicit=0, gore=1, neutral=2, suggestive=3`). `CLASS_ORDER` in
> `src/background/offscreen.ts` and `NsfwClass` in
> `src/content/analyzers/worker/protocol.ts` **must** match that exact order, or
> every prediction is silently mislabeled.

---

## Code style

- **TypeScript**, strict. Match the style of the file you're editing — it favors
  small, documented functions and comments that explain *why*, not *what*.
- No formatter is enforced in CI; keep diffs minimal and consistent with
  surrounding code (indentation, naming, import order).
- Prefer inline SVG for popup icons (the extension CSP blocks external assets).

## Verifying your change

There's no automated test suite, so verify by hand before opening a PR:

- `npm run build` is green (type-checks pass).
- Load the built `dist/` and scroll a real feed in **Smart** mode:
  - ordinary posts **reveal** (no over-blurring); sensitive posts **blur**;
  - the `[Lucid]` console line shows four sane class scores;
  - blocklist: add a custom term and confirm matching posts blur.
- Toggle **Off / Basic / Smart** and confirm the image model only runs in Smart.
- Describe exactly what you tested in the PR.

---

## Pull requests

1. Create a branch off `main`: `git checkout -b fix/short-description`.
2. Keep the change focused; one logical change per PR.
3. Use clear commit messages (conventional-commit prefixes like `fix:`, `feat:`,
   `docs:` are appreciated).
4. Ensure `npm run build` passes.
5. Open the PR against `main` with:
   - what changed and why,
   - how you verified it (browser + steps),
   - screenshots/GIFs for any UI change.

A maintainer will review. Please be patient and responsive to feedback.

---

## Reporting bugs

Use the issue tracker — see [`SUPPORT.md`](SUPPORT.md) for what to include
(browser/OS, platform, steps, and the `[Lucid]` console logs).

## License

By contributing, you agree that your contributions are licensed under the
project's [MIT License](LICENSE).
