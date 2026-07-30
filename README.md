# Reddit Image Handler

Tampermonkey userscript for [new Reddit](https://www.reddit.com) (`shreddit-*` UI).

## Features

- **Lightbox zoom** — scroll wheel, +/- buttons, 100% (1:1) fit, click-drag pan
- **Gallery support** — zoom/pan on multi-image posts; left/right nav zones at 1× zoom
- **Downloads** — save current or all gallery images with filenames based on post title
- **Title filter** — hide feed posts whose titles match configurable terms (persisted via Tampermonkey storage)
- **PotPlayer links** — "Open in PotPlayer" on YouTube posts; captures playback time, pauses embed, opens at same timestamp

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) (Firefox, Chrome, etc.)
2. Create a new script and paste the contents of [`Reddit-Image-Handler.user.js`](Reddit-Image-Handler.user.js), or install from a raw GitHub URL once published
3. Visit any `https://*.reddit.com/*` page

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
