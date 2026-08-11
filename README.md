# Lucid

> **A clearer feed.** An open-source Chrome (Manifest V3) extension that blurs
> explicit, graphic, and distracting content on Instagram and TikTok — using a
> fine-tuned vision model that runs **entirely on your device**.

No accounts, no servers, no tracking. Image classification happens locally via
[`onnxruntime-web`](https://onnxruntime.ai/); a user-curated hashtag/phrase
blocklist runs alongside it. Nothing about your feed ever leaves your browser.

<!-- TODO: add a demo GIF/screenshot here (feed → post pre-blurs → reveal). -->

---

## Features

- **On-device AI (Smart mode)** — a 4-class classifier (explicit / gore /
  neutral / suggestive) scans each post **thumbnail** and blurs sensitive
  imagery, with per-class confidence thresholds.
- **User blocklist** — add your own hashtags/phrases, or switch on curated
  category lists (NSFW / viral / engagement bait / distracting). All off by
  default — you opt in.
- **Three modes** — **Off** (inert), **Basic** (blocklist only, no AI), **Smart**
  (image model + blocklist).
- **Optimistic pre-blur** — Smart-mode posts blur instantly and reveal only if
  clean, so nothing sensitive flashes while inference runs.
- **Private by architecture** — no backend, no telemetry, no ads. The only
  network request is a one-time model download.

---

## How it works

```text
┌──────────────────────────────────────────────────────────────┐
│  Content script (per-tab)                                    │
│  Platform strategy → DOM observer → caption + thumbnail      │
│         ↓                                                    │
│  Stage 1 (~1 ms): user blocklist match                       │
│  Stage 2 (~700 ms): on-device image classifier (Smart mode)  │
│         ↓                                                    │
│  Decision combiner → blur overlay + verdict log + cache      │
└──────────────────────────────────────────────────────────────┘
                          ↑
            ┌─────────────┴─────────────┐
       Service worker          Offscreen document
       (routes messages)       (runs ONNX inference)
                                       ↑
                                  CDN model (cached)
```

**Two signals, one decision.** The image classifier (Smart only) and the
user blocklist (Basic + Smart) each can fire; the combiner blurs if either does.
Once a blur is applied it is never silently removed. Full details in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## Install (from source)

```bash
git clone https://github.com/darshanbajgain/lucid.git
cd lucid
npm install
npm run build      # → dist/
```

Then in Chrome:

1. Visit `chrome://extensions/`
2. Enable **Developer mode** (top right)
3. **Load unpacked** → select the `dist/` folder
4. Open Instagram or TikTok; click the Lucid icon for the popup

<!-- TODO: add the Chrome Web Store link once published. -->

---

## The model

The classifier is a fine-tune of [Marqo's ViT-tiny NSFW model](https://huggingface.co/Marqo/nsfw-image-detection-384),
retrained to 4 classes and exported to ONNX (~22 MB). It's hosted publicly and
downloaded once on first use, then cached in the browser.

- **Model card + weights:** [darshan12222/lucid-nsfw-4class](https://huggingface.co/darshan12222/lucid-nsfw-4class) · local copy: [`MODEL_CARD.md`](MODEL_CARD.md)
- Held-out macro F1 ≈ 0.83; see the model card for per-class metrics and limitations.

---

## Privacy

Everything runs on-device — no data collection, no backend, no telemetry. See
[`PRIVACY.md`](PRIVACY.md).

---

## Contributing

Contributions are welcome — bug fixes, platform-selector updates, new features.
Start with [`CONTRIBUTING.md`](CONTRIBUTING.md) for setup and workflow, and
[`docs/DEVELOPER_GUIDE.md`](docs/DEVELOPER_GUIDE.md) for how to build, debug, and
extend. Architecture lives in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

Questions or bug reports → [`SUPPORT.md`](SUPPORT.md).

---

## License

[MIT](LICENSE). The model weights are released separately under Apache-2.0
(see the model card).
