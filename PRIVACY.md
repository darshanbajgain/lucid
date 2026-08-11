# Privacy Policy

**Lucid runs entirely on your device. No accounts, no servers, no tracking.**

_Last updated: 2026-08-11_

## The short version

Lucid is an on-device browser extension. It does **not** collect, transmit, sell,
or share any personal data. There is no Lucid backend, no analytics, no ads, and
no telemetry. Everything it does happens locally in your browser.

## What Lucid does NOT do

- ❌ No data collection or user accounts
- ❌ No analytics / telemetry / crash reporting sent anywhere
- ❌ No ads, no tracking, no selling or sharing of data
- ❌ Your images, captions, feed, and browsing activity are **never** uploaded

## What is stored — locally only

Lucid keeps a small amount of state in your browser's local extension storage
(`chrome.storage.local`). It never leaves your device and is not synced:

- Your **protection level** (Off / Basic / Smart)
- Your **blocklist** — enabled categories and any custom terms you add
- A **daily feed-time counter** (minutes, reset each day)
- **Cached blur decisions** for posts already analysed (a performance cache)

You can erase all of it any time from the popup: **Settings → Reset today's stats**
or **Reset everything**.

## Image classification is on-device

In Smart mode, Lucid classifies post **thumbnails** to decide whether to blur them.
This inference runs **locally**, inside the extension, using an on-device model
([onnxruntime-web](https://onnxruntime.ai/)). Images are **not** sent to any
server for analysis.

## Network activity

The only network request Lucid makes is a **one-time download of the machine-learning
model file** (~22 MB) from a public release host (GitHub / Hugging Face). After
that it is cached in your browser and reused offline. This request contains no
personal data — it's a plain file download, the same as loading any public URL.

Lucid reads image thumbnails that your browser has **already loaded** from
Instagram/TikTok in order to classify them locally; it does not fetch your feed
or send anything back.

## Permissions and why they're needed

- **storage** — save your settings and the session counter locally.
- **activeTab / scripting** — run the content script that finds posts on the page.
- **offscreen** — run the on-device model in a hidden document (required by
  Manifest V3 to execute the WASM runtime).
- **host access** to `instagram.com`, `tiktok.com`, and their image CDNs — read
  thumbnails locally to classify them.
- **host access** to `github.com` — download the model file once.

## Changes

If this policy ever changes, the update will appear in this file in the public
repository, with a new "Last updated" date.

## Contact

Questions about privacy? Open an issue on the
[GitHub repository](https://github.com/darshanbajgain/lucid) — see
[SUPPORT.md](SUPPORT.md).
