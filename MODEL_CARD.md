---
license: apache-2.0
base_model: Marqo/nsfw-image-detection-384
pipeline_tag: image-classification
library_name: onnx
tags:
  - image-classification
  - content-moderation
  - nsfw-detection
  - on-device
  - onnx
  - vision-transformer
model-index:
  - name: lucid-nsfw-4class
    results:
      - task:
          type: image-classification
        metrics:
          - type: f1
            name: Macro F1 (held-out val)
            value: 0.825
          - type: accuracy
            name: Accuracy (held-out val)
            value: 0.815
---

# Lucid — 4-class content classifier (v1.2.0)

An on-device image classifier that flags **explicit, gore, neutral, and
suggestive** content in short-form social feeds (Instagram / TikTok thumbnails).
It is the model behind the [**Lucid** browser extension](https://github.com/darshanbajgain/lucid),
which blurs sensitive and distracting posts **entirely on the user's device** —
no server, no cloud inference.

- **Backbone:** fine-tune of [`Marqo/nsfw-image-detection-384`](https://huggingface.co/Marqo/nsfw-image-detection-384) (ViT-tiny, 384×384)
- **Head:** fresh 4-class linear head (replaces the base 2-class head)
- **Format:** FP32 ONNX (opset 17, static batch = 1), ~22 MB
- **Runtime:** [onnxruntime-web](https://onnxruntime.ai/) (WASM) in the browser

## Classes

The output layer follows **alphabetical class order** (the training `ImageFolder`
order). This mapping is fixed — do not reorder it:

| Index | Class | Meaning |
|:---:|---|---|
| 0 | `explicit` | Nudity / sexual content |
| 1 | `gore` | Graphic violence, gore, accidents, injury, blood |
| 2 | `neutral` | Everything safe / ordinary |
| 3 | `suggestive` | Revealing / borderline-sexual but not explicit |

`class_map.json` in this repo carries the same mapping plus the input spec.

## Intended use

- **Primary:** on-device pre-screening of feed **thumbnails** to decide whether to
  blur a post, with per-class confidence thresholds applied at the decision layer
  (the extension uses `explicit 0.55 · gore 0.55 · suggestive 0.70`).
- Suitable for **privacy-preserving, client-side** content filtering and
  digital-wellbeing tools.

### Out of scope

- ❌ Not a general-purpose safety/moderation system and **not** intended for
  automated moderation at scale or high-stakes decisions.
- ❌ Trained on the short-form-feed visual distribution; expect degraded accuracy
  on out-of-distribution imagery (documents, medical, artwork, etc.).
- ❌ Does not cover text, audio, or non-visual signals.

## How to use

Preprocessing (must match training): resize to **384×384**, RGB, scale to `[0,1]`,
normalize with **ImageNet** mean `[0.485, 0.456, 0.406]` / std `[0.229, 0.224, 0.225]`,
channels-first, batch of 1.

```python
import numpy as np, onnxruntime as ort
from PIL import Image

CLASSES = ["explicit", "gore", "neutral", "suggestive"]  # index order — fixed
MEAN = np.array([0.485, 0.456, 0.406], np.float32)
STD  = np.array([0.229, 0.224, 0.225], np.float32)

def preprocess(path):
    img = Image.open(path).convert("RGB").resize((384, 384))
    x = (np.asarray(img, np.float32) / 255.0 - MEAN) / STD
    return x.transpose(2, 0, 1)[None].astype(np.float32)  # (1, 3, 384, 384)

sess = ort.InferenceSession("lucid_nsfw_4class_fp32.onnx", providers=["CPUExecutionProvider"])
logits = sess.run(["logits"], {"pixel_values": preprocess("image.jpg")})[0][0]
probs = np.exp(logits - logits.max()); probs /= probs.sum()
print(dict(zip(CLASSES, probs.round(3))), "→", CLASSES[int(probs.argmax())])
```

- **Input name:** `pixel_values` — **Output name:** `logits` (shape `[1, 4]`; apply softmax).

## Training

- **Data (not released):** a mixture of **public datasets** (gore / violence /
  accident sets, used under their licenses and *cited, not re-hosted*) and
  **self-collected** short-form-feed images. The raw dataset carries copyright /
  platform-ToS constraints and is therefore **not redistributed** — only these
  trained weights are.
- **Class counts (train):** neutral 2104 · suggestive 1449 · explicit 989 · gore 1074
  (5,616 images total; a `skip` audit-sink is excluded). ~15% held out for validation.
- **Procedure:** two-stage fine-tune — head-only (10 epochs, lr 1e-3), then unfreeze
  the last 4 transformer blocks (8 epochs, lr 1e-5). Weighted cross-entropy
  (linear inverse-frequency) plus neutral downsampling to counter imbalance.
- **Hardware:** single free Colab T4.

## Evaluation

Held-out validation set (736 images):

| Class | Precision | Recall | **F1** |
|---|:---:|:---:|:---:|
| explicit | 0.820 | 0.892 | **0.854** |
| gore | 0.921 | 0.944 | **0.933** |
| neutral | 0.800 | 0.762 | **0.780** |
| suggestive | 0.743 | 0.719 | **0.731** |
| **macro avg** | 0.821 | 0.829 | **0.825** |
| **accuracy** | | | **0.815** |

`gore` is the most cleanly separated class (one leak in the whole val set). The
`suggestive ↔ neutral ↔ explicit` cluster is the fuzzy nudity boundary and the
main source of error.

## Limitations & biases

- **Explicit false positives.** `explicit` occasionally fires with high confidence
  on benign frames — notably video *cover frames* that differ from the visible tile.
  This is the model's precision budget, not a bug; the fix is harder neutral
  negatives in a future retrain.
- **`suggestive` is the softest class** (F1 0.73) — the first place to look if
  coverage feels off.
- **Skin-tone bias risk.** As with any NSFW/skin-related classifier, performance
  may vary across skin tones; this has not been formally audited. Use threshold
  gating and treat outputs as advisory, not authoritative.
- **Single-annotator labels** on a self-curated set — label noise and annotator
  bias are possible.

Because of these, deployments should keep a human-reversible action (e.g. a
"reveal" button) rather than hard-blocking.

## License

`apache-2.0`, consistent with the [Marqo base model](https://huggingface.co/Marqo/nsfw-image-detection-384).
Weights may be used freely under those terms; the training data is not included.

## Citation

```bibtex
@software{lucid_nsfw_4class_2026,
  author  = {Bajgain, Darshan},
  title   = {Lucid — 4-class on-device content classifier},
  year    = {2026},
  url     = {https://huggingface.co/darshan12222/lucid-nsfw-4class}
}
```

**Links:** [Lucid extension](https://github.com/darshanbajgain/lucid) ·
[base model](https://huggingface.co/Marqo/nsfw-image-detection-384)
