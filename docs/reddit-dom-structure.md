# Reddit Shreddit DOM — Post Titles & Media

Notes from live browser inspection (Cursor Browser / CDP) against new Reddit (`shreddit-*`), used by [Reddit-Image-Handler.user.js](../Reddit-Image-Handler.user.js).

Goal for follow-up work: as the feed loads and scrolls, **dynamically read each post’s title** and **filter on title content** (hide / skip / flag matching posts).

---

## Feed posts

Each card is a custom element:

```html
<shreddit-post
  id="t3_1v3luru"
  post-title="Desperate move by a little man"
  permalink="/r/SipsTea/comments/1v3luru/desperate_move_by_a_little_man/"
  author="…"
  subreddit-name="SipsTea"
  …
>
  …
</shreddit-post>
```

### Title sources (preferred order for feed filtering)

| Priority | Source | Notes |
|----------|--------|--------|
| 1 | `shreddit-post[post-title]` | Stable attribute; best for filtering |
| 2 | `a[id^="post-title-"]` or `h1[id^="post-title-"]` text | Visible title link/heading |
| 3 | `[slot="title"]` text | Shadow/slot title content |
| 4 | `document.title` on comment pages | Form: `"Title : r/subreddit"` |

**Do not use `img.alt` for titles.** Alt often contains OCR / meme text from the image (e.g. news-headline gibberish), not the post title.

### Identity

| Field | Example | Use |
|-------|---------|-----|
| `id` | `t3_1v3luru` | Stable post id (`t3_` + base36 id) |
| `permalink` | `/r/SipsTea/comments/1v3luru/…/` | Link + id parse |
| Path on comment pages | `/r/…/comments/{id}/…` | Resolve as `t3_{id}` |

---

## Scrolling / dynamic load

- The feed **virtualizes** posts: `shreddit-post` nodes appear and disappear as you scroll.
- Ads and promoted units may sit beside real posts; prefer `shreddit-post` (and/or `article[data-post-id]` wrappers when present).
- A **MutationObserver** on `document.body` (or the main feed container) watching `childList` + `subtree` is the right hook to:
  1. Discover new `shreddit-post` nodes
  2. Read `post-title`
  3. Apply filter rules
  4. Optionally clean up when nodes are removed

Suggested observe target: `#main-content`, `shreddit-feed`, or `document.body` (same pattern as the zoomer’s lightbox observer).

### Filtering sketch

```text
on added node matching shreddit-post (or containing one):
  title = el.getAttribute('post-title') || title link text
  if matchesFilter(title):
    hide / collapse / mark el (or closest article wrapper)
```

Keep a `WeakSet` / `Set` of already-handled `id`s so re-renders do not double-apply.

---

## Media inside a post

### Single-image posts

Image often remains **inside** the post tree even when lightbox is open:

```text
shreddit-post#t3_…
  └─ shreddit-media-lightbox-listener[post-id="t3_…"][permalink="…"]
       └─ … img.media-lightbox-img / .preview-img …
```

`shreddit-media-lightbox-listener` carries `post-id` and `permalink` — useful to bind media back to the post without walking the whole feed.

### Gallery posts

```html
<gallery-carousel
  post-id="t3_…"
  permalink="/r/…/comments/…/"
  …
>
  <ul>
    <li slot="page-1" style="visibility: visible">…<img class="media-lightbox-img">…</li>
    <li slot="page-2" style="visibility: hidden">…</li>
  </ul>
</gallery-carousel>
```

| Concern | Detail |
|---------|--------|
| Active slide | `li` with `style.visibility === 'visible'` |
| Index | `slot="page-N"` → `N` (1-based) |
| Multiple carousels | Feed can leave **several** `gallery-carousel` nodes in the DOM at once |

**Pitfall:** `document.querySelectorAll('gallery-carousel li')` mixes feed previews with the lightbox gallery. Always scope to:

1. `img.closest('gallery-carousel')`, or  
2. A carousel whose box is roughly fullscreen (`area > ~25%` of viewport), not a small feed preview.

---

## Lightbox chrome

| Selector / signal | Meaning |
|-------------------|---------|
| `shreddit-media-lightbox` / `#shreddit-media-lightbox` | Lightbox host |
| `location.hash === '#lightbox'` | Lightbox route |
| `[aria-label="Close lightbox"]` | Close control (also used to detect open state) |
| `[aria-label="Next page"]` / `Previous page` | Gallery nav (often in shadow DOM) |
| `Page N (Current page)` (a11y name) | Alternate index signal |

### Resolving “which post is in the lightbox?”

Preferred order (as implemented in the userscript):

1. Active img → `closest('shreddit-media-lightbox-listener')[post-id]` → `#t3_…`
2. Active img → `closest('shreddit-post')`
3. Active img → `closest('gallery-carousel')[post-id]`
4. URL `/comments/{id}/` → `#t3_{id}`
5. Fullscreen-sized `gallery-carousel` only (not tiny feed carousels)
6. Cached post from the click that opened the lightbox
7. `document.title` (`Title : r/sub`)

---

## Image URLs (download / filter side-effects)

| Kind | Host | Notes |
|------|------|--------|
| Preview | `preview.redd.it/…-v0-{hash}.{ext}?width=…` | Common in feed + lightbox |
| Original | `i.redd.it/{hash}.{ext}` | Prefer for downloads; CORS from `reddit.com` works |

Rewrite: take `-v0-([a-z0-9]+)\.(jpe?g|png|gif|webp)` from the preview path → `https://i.redd.it/$1.$2`.

Largest candidate: parse `srcset` widths and pick the max `Nw` entry before falling back to `src`.

---

## Filename pattern (current download feature)

```text
{WindowsSanitizedTitle} {carouselIndex}.{ext}
```

- Sanitize: strip `\ / : * ? " < > |`, control chars; trim trailing dots/spaces; avoid `CON`/`PRN`/…; cap ~180 chars.
- Single image → index `1`.
- Gallery → `slot` page number.

---

## Live title filtering (userscript)

Implemented in `initTitleFilter()` (v0.9.0+):

- **UI:** fixed **Filters** button (bottom-left). Opens a panel with a textarea — **one phrase per line**.
- **Match:** case-insensitive substring against `shreddit-post[post-title]` (plus title link/slot fallbacks). Matching posts are hidden (`display: none`).
- **Persistence:** Tampermonkey script storage via `GM_getValue` / `GM_setValue` (key `riz-title-filters`). Enable **Tampermonkey Sync** to keep filters across browsers on the same TM account. Older `localStorage` values are migrated once on first load.
- **Observer:** watches new `shreddit-post` nodes and `post-title` attribute updates while the feed scrolls/virtualizes.
- **Badge:** button shows how many currently mounted posts are hidden.

Apply saves and re-scans; Clear empties the list and un-hides posts.


---

## Quick selector cheat sheet

```js
// All currently mounted posts
document.querySelectorAll('shreddit-post')

// Title
post.getAttribute('post-title')

// Id
post.id  // "t3_…"

// Media → post
img.closest('shreddit-media-lightbox-listener')?.getAttribute('post-id')
img.closest('shreddit-post')

// Active gallery slide
gallery.querySelector('li[style*="visibility: visible"]')  // or li.style.visibility === 'visible'
li.getAttribute('slot')  // "page-1"
```

---

## Related script behavior

The zoomer caches the clicked post on media click (`lastLightboxPostId` / `lastLightboxTitle`) because feed virtualization can remove the originating card while the lightbox stays open. Feed **filtering** should key off live `shreddit-post` nodes instead, and treat the cache only as a lightbox fallback.
