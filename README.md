# Reddit Image Handler

Tampermonkey userscript for [new Reddit](https://www.reddit.com) (`shreddit-*` UI).

## Features

- **Lightbox zoom** — scroll wheel, +/- buttons, 100% (1:1) fit, click-drag pan
- **Gallery support** — zoom/pan on multi-image posts; left/right nav zones at 1× zoom
- **Downloads** — save current or all gallery images with filenames based on post title
- **Title filter** — hide feed posts whose titles match configurable terms (persisted via Tampermonkey storage)
- **PotPlayer links** — "Open in PotPlayer" on YouTube posts; captures playback time, pauses embed, opens at same timestamp

## Install

You need [Tampermonkey](https://www.tampermonkey.net/) first:

- **Firefox:** [Add-ons page](https://addons.mozilla.org/firefox/addon/tampermonkey/)
- **Chrome / Edge / Brave:** [Chrome Web Store](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)

Then install **Reddit Image Handler** using either method below.

### Method 1 — Install from URL (easiest)

1. Open Tampermonkey → **Dashboard**
2. Click the **+** tab (or **Utilities** → **Install from URL…**)
3. Paste this URL and confirm install:

   ```
   https://raw.githubusercontent.com/danelovu/reddit-image-handler/master/Reddit-Image-Handler.user.js
   ```

4. Tampermonkey should show **Reddit Image Zoomer** — click **Install**

### Method 2 — Copy the script manually

1. Open [`Reddit-Image-Handler.user.js`](Reddit-Image-Handler.user.js) on GitHub (click **Raw** for the full file)
2. Copy the entire file contents
3. Tampermonkey → **Create a new script…**
4. Select all default template text, paste, and **Save** (Ctrl+S)

### Verify it works

1. Go to any Reddit post with an image, e.g. a subreddit feed or comment page
2. Click an image to open the lightbox
3. You should see **+ / − / 100%** controls on the right and scroll-wheel zoom should work

If the script does not run, check Tampermonkey’s icon — ensure the script is **enabled** for `reddit.com` and that Tampermonkey itself is allowed on the site (some browsers block extensions in private windows).

### Updating

When a new version is pushed to GitHub, Tampermonkey may prompt you to update. You can also reinstall from the URL above or use **Dashboard** → script → **Check for userscript updates** (if enabled in Tampermonkey settings).

## Usage

| Feature | How |
|---------|-----|
| Open lightbox | Click a post image (or `#lightbox` URL) |
| Zoom | Mouse wheel over lightbox, or +/- / **100%** controls |
| Pan | Click-drag when zoomed in |
| Download | ↓ (current) or ⇩ (all gallery slides) on the control panel |
| Title filter | Use the filter panel (terms stored in Tampermonkey) |
| PotPlayer | Click **Open in PotPlayer** under a YouTube embed (requires `potplayer://` protocol on Windows) |

## Files

| File | Purpose |
|------|---------|
| `Reddit-Image-Handler.user.js` | Main userscript |
| `docs/reddit-dom-structure.md` | DOM notes from live Reddit inspection |

## Requirements

- Tampermonkey with `GM_getValue` / `GM_setValue` grants (included in script header)
- PotPlayer + protocol handler or YouTube extension (optional, for PotPlayer feature)

## License

MIT
