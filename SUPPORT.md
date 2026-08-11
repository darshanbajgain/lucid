# Support

Thanks for using **Lucid** — an on-device extension that blurs explicit,
graphic, and distracting content on Instagram and TikTok.

## Get help / report a bug

Open an issue on the GitHub repository:

👉 **<https://github.com/darshanbajgain/lucid/issues>**

To help us reproduce a problem quickly, please include:

- Your **browser** and version (e.g. Chrome 128) and OS
- The **platform** (Instagram or TikTok) and where it happened (feed, reels, …)
- What you expected vs. what actually happened
- Relevant **console logs** — open DevTools on the page, switch the console
  context to **Lucid**, and copy any `[Lucid]` lines (see the README's
  debugging section). For model/inference issues, also check the offscreen /
  service-worker console via `chrome://extensions → Lucid → Inspect views`.

## Frequently asked questions

**A normal post got blurred (false positive).**
Smart mode uses an on-device model that isn't perfect. You can lower sensitivity
by switching to **Basic** (keywords only) or **Off**, or reveal the post with the
button on the blur overlay. Persistent false positives are useful bug reports.

**Something explicit slipped through (false negative).**
The model runs on the post's thumbnail and can miss borderline cases. Add related
hashtags/phrases to your **Custom blocklist** to catch them by caption.

**How do I filter specific topics or hashtags?**
Popup → **Custom blocklist** → type a hashtag or phrase → **Add**. You can also
switch on the curated **Category lists** (NSFW / viral / engagement / distracting),
which are all off by default.

**The first load seemed slow / used data.**
On first use in Smart mode, Lucid downloads the ~22 MB model once, then caches it
and works offline. See [PRIVACY.md](PRIVACY.md).

**Does Lucid send my data anywhere?**
No. Everything runs on your device. See [PRIVACY.md](PRIVACY.md).

**How do I turn it off or reset it?**
Set the protection level to **Off**, or use **Settings → Reset today's stats /
Reset everything** in the popup.

## Contributing

Bug fixes and platform-selector updates are welcome — see the developer guide in
[`docs/DEVELOPER_GUIDE.md`](docs/DEVELOPER_GUIDE.md).
