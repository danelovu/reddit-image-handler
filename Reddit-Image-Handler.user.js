// ==UserScript==
// @name         Reddit Image Zoomer
// @namespace    http://tampermonkey.net/
// @version      0.9.9
// @description  Zoom Reddit lightbox images; download with titled filenames; filter feed posts by title; PotPlayer links for YouTube posts
// @run-at       document-idle
// @author       You
// @match        https://*.reddit.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// ==/UserScript==

(function() {
    'use strict';

    const OPEN_GRACE_MS = 800;
    let openGraceUntil = 0;

    const markLightboxOpening = () => {
        openGraceUntil = Date.now() + OPEN_GRACE_MS;
    };

    const DEBUG = false;
    
    const log = (...args) => {
        if (DEBUG) console.log('[Reddit Image Zoomer]', ...args);
    };

    const initZoomHandler = () => {
        const MIN_SCALE = 1;
        const MAX_SCALE = 20;
        const ZOOM_STEP = 1.1;
        const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

        const LIGHTBOX_IMG_SELECTORS = [
            'img.media-lightbox-img',
            // Single-image posts: the visible image lives here; media-lightbox-img collapses to 0×0
            '.lightboxed-content img',
        ];

        const collectLightboxImages = (root, into) => {
            if (!root?.querySelectorAll) return;
            for (const sel of LIGHTBOX_IMG_SELECTORS) {
                root.querySelectorAll(sel).forEach(img => into.add(img));
            }
        };

        const findLightboxImages = () => {
            const imgs = new Set();
            collectLightboxImages(document, imgs);
            const host = document.querySelector('shreddit-media-lightbox');
            if (host?.shadowRoot) {
                collectLightboxImages(host.shadowRoot, imgs);
                host.shadowRoot.querySelectorAll('*').forEach(el => {
                    if (el.shadowRoot) collectLightboxImages(el.shadowRoot, imgs);
                });
            }
            return [...imgs];
        };

        const rectIntersectsViewport = (r) => (
            r.right > 0 && r.left < window.innerWidth
            && r.bottom > 0 && r.top < window.innerHeight
        );

        const findActiveLightboxImage = () => {
            const candidates = findLightboxImages().filter(img => img.src).filter(img => {
                const r = img.getBoundingClientRect();
                const cs = getComputedStyle(img);
                return r.width > 100 && r.height > 100
                    && rectIntersectsViewport(r)
                    && cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
            });
            if (!candidates.length) return null;

            const cx = window.innerWidth / 2;
            const cy = window.innerHeight / 2;
            return candidates.sort((a, b) => {
                const ra = a.getBoundingClientRect();
                const rb = b.getBoundingClientRect();
                const da = Math.hypot(ra.left + ra.width / 2 - cx, ra.top + ra.height / 2 - cy);
                const db = Math.hypot(rb.left + rb.width / 2 - cx, rb.top + rb.height / 2 - cy);
                return da - db;
            })[0];
        };

        let lastLightboxPostId = null;
        let lastLightboxTitle = null;
        let downloadBusy = false;

        const RESERVED_WIN_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

        const sanitizeFilename = (str) => {
            let s = String(str ?? '')
                .replace(/[\\/:*?"<>|]/g, '')
                .replace(/[\x00-\x1f]/g, '')
                .replace(/\s+/g, ' ')
                .trim()
                .replace(/[. ]+$/g, '');
            if (!s) s = 'Untitled';
            if (RESERVED_WIN_NAMES.test(s)) s = `${s}_`;
            if (s.length > 180) s = s.slice(0, 180).replace(/[. ]+$/g, '');
            return s || 'Untitled';
        };

        const getActiveGallery = () => {
            const img = findActiveLightboxImage();
            const containing = img?.closest?.('gallery-carousel');
            if (containing) return containing;

            // Prefer fullscreen-sized carousels only — feed preview carousels are smaller
            // and must not win title/index resolution for a single-image lightbox.
            const viewportArea = Math.max(1, window.innerWidth * window.innerHeight);
            const ranked = [...document.querySelectorAll('gallery-carousel')]
                .map((el) => {
                    const r = el.getBoundingClientRect();
                    return { el, area: Math.max(0, r.width) * Math.max(0, r.height) };
                })
                .filter((g) => g.area > viewportArea * 0.25)
                .sort((a, b) => b.area - a.area);
            return ranked[0]?.el || null;
        };

        const titleFromPostEl = (postEl) => {
            if (!postEl) return null;
            return postEl.getAttribute('post-title')?.trim()
                || postEl.querySelector('h1[id^="post-title-"]')?.textContent?.trim()
                || postEl.querySelector('a[id^="post-title-"]')?.textContent?.trim()
                || postEl.querySelector('[slot="title"]')?.textContent?.trim()
                || null;
        };

        const getPostIdFromPath = () => {
            const m = location.pathname.match(/\/comments\/([a-z0-9]+)\//i);
            return m ? `t3_${m[1]}` : null;
        };

        const titleFromDocumentTitle = () => {
            const raw = (document.title || '').trim();
            if (!raw) return null;
            // "Desperate move by a little man : r/SipsTea"
            const m = raw.match(/^(.*?)\s*:\s*r\//i);
            const title = (m?.[1] || raw).trim();
            return title || null;
        };

        const cachePostFromElement = (el) => {
            const post = el?.closest?.('shreddit-post');
            if (!post) return;
            lastLightboxPostId = post.id || post.getAttribute('id') || null;
            lastLightboxTitle = titleFromPostEl(post) || null;
            log('Cached lightbox post:', lastLightboxPostId, lastLightboxTitle);
        };

        const cacheResolvedPost = (postEl) => {
            if (!postEl) return;
            lastLightboxPostId = postEl.id || postEl.getAttribute('id') || lastLightboxPostId;
            lastLightboxTitle = titleFromPostEl(postEl) || lastLightboxTitle;
        };

        const resolveLightboxPostEl = () => {
            const img = findActiveLightboxImage();

            // Active image is still under the post / lightbox listener for single-image posts
            const listenerId = img?.closest?.('shreddit-media-lightbox-listener')?.getAttribute('post-id');
            if (listenerId) {
                const fromListener = document.getElementById(listenerId);
                if (fromListener) return fromListener;
            }

            const closestPost = img?.closest?.('shreddit-post');
            if (closestPost) return closestPost;

            const containingGallery = img?.closest?.('gallery-carousel');
            const containingGalleryId = containingGallery?.getAttribute('post-id');
            if (containingGalleryId) {
                const fromGallery = document.getElementById(containingGalleryId);
                if (fromGallery) return fromGallery;
            }

            const pathId = getPostIdFromPath();
            if (pathId) {
                const fromPath = document.getElementById(pathId);
                if (fromPath) return fromPath;
            }

            // Fullscreen gallery only (not a small feed preview carousel)
            const activeGallery = getActiveGallery();
            const activeGalleryId = activeGallery?.getAttribute('post-id');
            if (activeGalleryId) {
                const fromActiveGallery = document.getElementById(activeGalleryId);
                if (fromActiveGallery) return fromActiveGallery;
            }

            if (lastLightboxPostId) {
                const fromCache = document.getElementById(lastLightboxPostId);
                if (fromCache) return fromCache;
            }

            return document.querySelector('shreddit-post');
        };

        const getPostTitle = () => {
            const postEl = resolveLightboxPostEl();
            let title = titleFromPostEl(postEl);
            if (!title && postEl?.id && postEl.id === lastLightboxPostId) {
                title = lastLightboxTitle;
            }
            if (!title) title = titleFromDocumentTitle();
            // Do not use img.alt — Reddit often puts OCR / meme text there, not the post title.
            if (title && postEl) cacheResolvedPost(postEl);
            return title || 'Untitled';
        };

        const parsePageSlot = (li) => {
            const m = li?.getAttribute('slot')?.match(/^page-(\d+)$/i);
            return m ? parseInt(m[1], 10) : null;
        };

        const getVisibleSlideLi = (gallery) => {
            if (!gallery) return null;
            return [...gallery.querySelectorAll('li')].find((li) => li.style.visibility === 'visible') || null;
        };

        const getCarouselIndex = () => {
            const gallery = getActiveGallery();
            if (!gallery) return 1;
            const visible = getVisibleSlideLi(gallery);
            if (!visible) return 1;
            const fromSlot = parsePageSlot(visible);
            if (fromSlot) return fromSlot;
            const idx = [...gallery.querySelectorAll('li')].indexOf(visible);
            return idx >= 0 ? idx + 1 : 1;
        };

        const largestFromSrcset = (srcset) => {
            if (!srcset) return null;
            let best = null;
            let bestW = -1;
            for (const part of srcset.split(',')) {
                const bits = part.trim().split(/\s+/);
                const url = bits[0];
                const w = parseInt((bits[1] || '').replace(/w$/i, ''), 10) || 0;
                if (url && w >= bestW) {
                    bestW = w;
                    best = url;
                }
            }
            return best;
        };

        const toOriginalUrl = (url) => {
            if (!url) return null;
            try {
                const u = new URL(url, location.href);
                const host = u.hostname.toLowerCase();
                if (host !== 'preview.redd.it' && host !== 'i.redd.it') return url;
                const file = u.pathname.split('/').pop() || '';
                const hashed = file.match(/-v0-([a-z0-9]+)\.(jpe?g|png|gif|webp)$/i);
                if (hashed) {
                    return `https://i.redd.it/${hashed[1]}.${hashed[2].toLowerCase()}`;
                }
                u.hostname = 'i.redd.it';
                u.search = '';
                return u.toString();
            } catch {
                return url;
            }
        };

        const getExtensionFromUrl = (url) => {
            const m = String(url).match(/\.(gif|png|jpe?g|webp)(?:\?|$)/i);
            if (!m) return '.jpg';
            const ext = m[1].toLowerCase();
            return ext === 'jpeg' ? '.jpg' : `.${ext}`;
        };

        const getSlideUrlFromImg = (img) => {
            if (!img) return null;
            const li = img.closest?.('li');
            const hiRes = li?.querySelector('.lightboxed-content img, zoomable-img img')
                || img.closest?.('.media-lightbox-img')?.parentElement?.querySelector(
                    '.lightboxed-content img, zoomable-img img'
                );
            const candidates = [
                hiRes?.currentSrc,
                hiRes?.src,
                largestFromSrcset(img.getAttribute('srcset')),
                img.currentSrc,
                img.src,
            ].filter(Boolean);
            if (!candidates.length) return null;
            return toOriginalUrl(candidates[0]) || candidates[0];
        };

        const collectGallerySlides = () => {
            const gallery = getActiveGallery();
            if (!gallery) {
                const img = findActiveLightboxImage();
                const url = getSlideUrlFromImg(img);
                return url ? [{ index: 1, url, img }] : [];
            }

            const byIndex = new Map();
            [...gallery.querySelectorAll('li')].forEach((li, i) => {
                const img = li.querySelector('img.media-lightbox-img') || li.querySelector('img');
                const index = parsePageSlot(li) || (i + 1);
                const url = getSlideUrlFromImg(img);
                if (!url || byIndex.has(index)) return;
                byIndex.set(index, { index, url, img, li });
            });
            return [...byIndex.values()].sort((a, b) => a.index - b.index);
        };

        const buildDownloadFilename = (title, index, url) => (
            `${sanitizeFilename(title)} ${index}${getExtensionFromUrl(url)}`
        );

        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

        const saveBlob = async (url, filename) => {
            try {
                const res = await fetch(url, { credentials: 'omit', mode: 'cors' });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const blob = await res.blob();
                const objectUrl = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = objectUrl;
                a.download = filename;
                a.rel = 'noopener';
                document.body.appendChild(a);
                a.click();
                a.remove();
                setTimeout(() => URL.revokeObjectURL(objectUrl), 2000);
                log('Saved:', filename);
                return true;
            } catch (err) {
                log('saveBlob failed, opening tab:', filename, err);
                window.open(url, '_blank', 'noopener');
                return false;
            }
        };

        const setDownloadBusy = (busy, progressText) => {
            downloadBusy = busy;
            if (!zoomControls) return;
            const cur = zoomControls.querySelector('.riz-dl-current');
            const all = zoomControls.querySelector('.riz-dl-all');
            if (cur) cur.disabled = busy;
            if (all) {
                all.disabled = busy;
                if (busy && progressText) {
                    all.textContent = progressText;
                    all.classList.add('riz-btn-progress');
                } else if (!busy) {
                    all.textContent = '⇩';
                    all.classList.remove('riz-btn-progress');
                }
            }
        };

        const findGalleryNextButton = (gallery) => {
            if (!gallery) return null;
            const stack = [gallery];
            while (stack.length) {
                const root = stack.pop();
                if (!root?.querySelectorAll) continue;
                for (const el of root.querySelectorAll('*')) {
                    const label = el.getAttribute?.('aria-label') || '';
                    if (/^Next( page)?$/i.test(label) && el.tagName === 'BUTTON') {
                        const r = el.getBoundingClientRect();
                        if (r.width > 0 && r.height > 0) return el;
                    }
                    if (el.shadowRoot) stack.push(el.shadowRoot);
                }
            }
            const close = document.querySelector('[aria-label="Close lightbox"]');
            const parent = close?.parentElement;
            return parent?.querySelector('[aria-label="Next page"], [aria-label="Next"]') || null;
        };

        const hydrateMissingSlides = async (gallery, expectedCount) => {
            if (!gallery || expectedCount <= 0) return collectGallerySlides();
            let slides = collectGallerySlides();
            if (slides.length >= expectedCount) return slides;

            const startIndex = getCarouselIndex();
            const nextBtn = findGalleryNextButton(gallery);
            if (!nextBtn) return slides;

            for (let i = 0; i < expectedCount + 2 && slides.length < expectedCount; i++) {
                nextBtn.click();
                await sleep(350);
                slides = collectGallerySlides();
            }

            // Prefer restoring by clicking page button if available; otherwise advance until startIndex
            for (let guard = 0; guard < expectedCount + 2 && getCarouselIndex() !== startIndex; guard++) {
                nextBtn.click();
                await sleep(250);
            }
            return collectGallerySlides();
        };

        const downloadCurrent = async () => {
            if (downloadBusy) return;
            const title = getPostTitle();
            const gallery = getActiveGallery();
            const visible = getVisibleSlideLi(gallery);
            const img = visible?.querySelector('img.media-lightbox-img')
                || visible?.querySelector('img')
                || findActiveLightboxImage();
            const index = getCarouselIndex();
            const url = getSlideUrlFromImg(img);
            if (!url) {
                log('No URL for current slide');
                return;
            }
            const filename = buildDownloadFilename(title, index, url);
            log('Download current:', filename, url.slice(0, 100));
            setDownloadBusy(true);
            try {
                await saveBlob(url, filename);
            } finally {
                setDownloadBusy(false);
            }
        };

        const downloadAll = async () => {
            if (downloadBusy) return;
            const title = getPostTitle();
            const gallery = getActiveGallery();
            const expected = gallery
                ? new Set([...gallery.querySelectorAll('li')].map((li, i) => parsePageSlot(li) || (i + 1))).size
                : 1;

            setDownloadBusy(true, `0/${expected}`);
            try {
                let slides = collectGallerySlides();
                if (gallery && slides.length < expected) {
                    slides = await hydrateMissingSlides(gallery, expected);
                }
                if (!slides.length) {
                    log('No slides to download');
                    return;
                }
                log('Download all:', slides.length, 'slides for', title);
                for (let i = 0; i < slides.length; i++) {
                    const slide = slides[i];
                    setDownloadBusy(true, `${i + 1}/${slides.length}`);
                    const filename = buildDownloadFilename(title, slide.index, slide.url);
                    await saveBlob(slide.url, filename);
                    if (i < slides.length - 1) await sleep(350);
                }
            } finally {
                setDownloadBusy(false);
            }
        };

        const isLightboxChromeVisible = () => {
            const close = document.querySelector('[aria-label="Close lightbox"]');
            if (!close) return false;
            const r = close.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
        };

        const isFullscreenImageView = () => {
            if (location.pathname === '/media') return true;

            const host = document.querySelector('shreddit-media-lightbox');
            if (host?.shadowRoot) {
                const dialog = host.shadowRoot.querySelector('rpl-dialog');
                if (dialog) {
                    const cs = getComputedStyle(dialog);
                    const rect = dialog.getBoundingClientRect();
                    if (cs.display !== 'none' && cs.visibility !== 'hidden' && rect.width > 0 && rect.height > 0) {
                        return true;
                    }
                }
            }

            if (isLightboxChromeVisible()) return true;

            return false;
        };

        const shouldIntercept = () => {
            if (Date.now() < openGraceUntil) return false;
            return isFullscreenImageView();
        };

        const isOverImage = (img, e) => {
            const rect = img.getBoundingClientRect();
            return e.clientX >= rect.left && e.clientX <= rect.right
                && e.clientY >= rect.top && e.clientY <= rect.bottom;
        };

        const WHEEL_IGNORE_SELECTORS = [
            '#reddit-image-zoomer-controls',
            '[aria-label="Close lightbox"]',
            '[aria-label="Next"]',
            '[aria-label="Previous"]',
            '[aria-label="Next page"]',
            '[aria-label="Previous page"]',
        ].join(', ');

        const isWheelZoomTarget = (e) => !e.target.closest?.(WHEEL_IGNORE_SELECTORS);

        const ensureZoomState = (img) => {
            if (!img._riz) {
                img._riz = { scale: 1, tx: 0, ty: 0, dragging: false, startX: 0, startY: 0 };
                img.style.transformOrigin = '0 0';
                img.style.willChange = 'transform';
            }
            return img._riz;
        };

        const applyTransform = (img) => {
            const state = img._riz;
            img.style.transform = `translate(${state.tx}px, ${state.ty}px) scale(${state.scale})`;
        };

        let zoomControls = null;

        const getImageAnchor = (img) => {
            const rect = img.getBoundingClientRect();
            return {
                x: rect.left + rect.width / 2,
                y: rect.top + rect.height / 2,
            };
        };

        const updateZoomControlsVisibility = () => {
            if (!zoomControls) return;
            const show = isFullscreenImageView();
            zoomControls.style.display = show ? 'flex' : 'none';
            if (show) updateZoomPercentLabel();
        };

        const handleLightboxClose = () => {
            openGraceUntil = 0;
            deactivateInterceptors();
            if (zoomControls) zoomControls.style.display = 'none';
            findLightboxImages().forEach(disableLightboxImage);
            scheduleScan();
        };

        const captureBaseLayoutSize = (img) => {
            const state = ensureZoomState(img);
            if (state.baseW) return;
            const r = img.getBoundingClientRect();
            state.baseW = r.width / state.scale;
            state.baseH = r.height / state.scale;
        };

        const getOneToOneScale = (img) => {
            captureBaseLayoutSize(img);
            const state = img._riz;
            if (!img.naturalWidth || !state?.baseW) return 1;
            return img.naturalWidth / state.baseW;
        };

        const getZoomPercent = (img) => {
            const state = img._riz;
            if (!state) return 100;
            return Math.round((state.scale / getOneToOneScale(img)) * 100);
        };

        const updateZoomPercentLabel = () => {
            if (!zoomControls) return;
            const label = zoomControls.querySelector('.riz-zoom-label');
            if (!label) return;
            const img = findActiveLightboxImage();
            label.textContent = img ? `${getZoomPercent(img)}%` : '100%';
        };

        const setImageScale = (img, newScale, anchorX, anchorY) => {
            const state = ensureZoomState(img);
            newScale = clamp(newScale, MIN_SCALE, MAX_SCALE);
            if (newScale === state.scale) return;

            if (newScale === 1) {
                state.scale = 1;
                state.tx = 0;
                state.ty = 0;
            } else {
                const rect = img.getBoundingClientRect();
                const kActual = newScale / state.scale;
                const mx = anchorX - rect.left;
                const my = anchorY - rect.top;
                state.tx += mx * (1 - kActual);
                state.ty += my * (1 - kActual);
                state.scale = newScale;
            }
            applyTransform(img);
            updateImageCursor(img);
            updateZoomPercentLabel();
        };

        const stepImageZoom = (direction) => {
            const img = findActiveLightboxImage();
            if (!img) return;
            const state = ensureZoomState(img);
            const anchor = getImageAnchor(img);
            const factor = direction > 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
            setImageScale(img, state.scale * factor, anchor.x, anchor.y);
        };

        const zoomToFullResolution = () => {
            const img = findActiveLightboxImage();
            if (!img) return;
            const target = clamp(getOneToOneScale(img), MIN_SCALE, MAX_SCALE);
            setImageScale(img, target, window.innerWidth / 2, window.innerHeight / 2);
        };

        const createZoomControls = () => {
            document.getElementById('reddit-image-zoomer-controls')?.remove();

            const style = document.createElement('style');
            style.textContent = `
                #reddit-image-zoomer-controls {
                    position: fixed;
                    right: 16px;
                    bottom: 16px;
                    z-index: 10001;
                    display: none;
                    flex-direction: column;
                    align-items: center;
                    gap: 8px;
                    padding: 10px 8px;
                    border-radius: 10px;
                    background: rgba(0, 0, 0, 0.72);
                    border: 1px solid rgba(255, 255, 255, 0.15);
                    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.45);
                    font-family: system-ui, -apple-system, sans-serif;
                    user-select: none;
                    touch-action: manipulation;
                }
                #reddit-image-zoomer-controls .riz-btn {
                    width: 44px;
                    height: 44px;
                    border: none;
                    border-radius: 8px;
                    background: rgba(255, 255, 255, 0.12);
                    color: #fff;
                    font-size: 24px;
                    line-height: 1;
                    cursor: pointer;
                }
                #reddit-image-zoomer-controls .riz-btn:hover {
                    background: rgba(255, 255, 255, 0.22);
                }
                #reddit-image-zoomer-controls .riz-btn:active {
                    background: rgba(255, 255, 255, 0.3);
                }
                #reddit-image-zoomer-controls .riz-zoom-label {
                    min-width: 44px;
                    padding: 2px 4px;
                    color: #fff;
                    font-size: 13px;
                    font-weight: 600;
                    text-align: center;
                    line-height: 1.2;
                }
                #reddit-image-zoomer-controls .riz-btn-fit {
                    font-size: 11px;
                    font-weight: 700;
                    letter-spacing: -0.02em;
                }
                #reddit-image-zoomer-controls .riz-btn-progress {
                    font-size: 11px;
                    font-weight: 700;
                }
                #reddit-image-zoomer-controls .riz-btn:disabled {
                    opacity: 0.45;
                    cursor: default;
                }
                #reddit-image-zoomer-controls .riz-dl-sep {
                    width: 28px;
                    height: 1px;
                    margin: 2px 0;
                    background: rgba(255, 255, 255, 0.2);
                }
            `;
            document.head.appendChild(style);

            const panel = document.createElement('div');
            panel.id = 'reddit-image-zoomer-controls';
            panel.innerHTML = `
                <div class="riz-zoom-label" aria-live="polite">100%</div>
                <button type="button" class="riz-btn riz-zoom-in" title="Zoom in" aria-label="Zoom in">+</button>
                <button type="button" class="riz-btn riz-zoom-out" title="Zoom out" aria-label="Zoom out">&minus;</button>
                <button type="button" class="riz-btn riz-btn-fit riz-zoom-fit" title="Zoom to 100% (1:1 pixels)" aria-label="Zoom to 100%">100%</button>
                <div class="riz-dl-sep" aria-hidden="true"></div>
                <button type="button" class="riz-btn riz-dl-current" title="Download current" aria-label="Download current">↓</button>
                <button type="button" class="riz-btn riz-dl-all" title="Download all" aria-label="Download all">⇩</button>
            `;
            document.body.appendChild(panel);

            zoomControls = panel;

            const stop = (e) => e.stopPropagation();

            panel.addEventListener('mousedown', stop);
            panel.addEventListener('click', stop);
            panel.addEventListener('wheel', stop, { passive: true });

            panel.querySelector('.riz-zoom-in').addEventListener('click', (e) => {
                e.preventDefault();
                stepImageZoom(1);
            });
            panel.querySelector('.riz-zoom-out').addEventListener('click', (e) => {
                e.preventDefault();
                stepImageZoom(-1);
            });
            panel.querySelector('.riz-zoom-fit').addEventListener('click', (e) => {
                e.preventDefault();
                zoomToFullResolution();
            });
            panel.querySelector('.riz-dl-current').addEventListener('click', (e) => {
                e.preventDefault();
                downloadCurrent();
            });
            panel.querySelector('.riz-dl-all').addEventListener('click', (e) => {
                e.preventDefault();
                downloadAll();
            });

            return panel;
        };

        const updateImageCursor = (img) => {
            const state = img._riz;
            if (!state) return;
            if (!isFullscreenImageView()) {
                img.style.cursor = '';
                return;
            }
            img.style.cursor = state.dragging ? 'grabbing' : 'grab';
        };

        const applyWheelZoom = (img, e) => {
            const state = ensureZoomState(img);
            const k = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
            setImageScale(img, state.scale * k, e.clientX, e.clientY);
        };

        let dragImg = null;
        let interceptorsActive = false;
        let wheelListenerActive = false;

        const CAPTURE_OPTS = { capture: true };
        const WHEEL_OPTS = { capture: true, passive: false };

        const onCaptureWheel = (e) => {
            if (!isFullscreenImageView()) return;

            const img = findActiveLightboxImage();
            if (!isWheelZoomTarget(e)) return;

            e.preventDefault();
            e.stopPropagation();

            if (img) applyWheelZoom(img, e);
        };

        const ensureWheelListener = () => {
            if (wheelListenerActive) return;
            wheelListenerActive = true;
            window.addEventListener('wheel', onCaptureWheel, WHEEL_OPTS);
        };

        const bindLightboxWheelTargets = () => {
            if (!isFullscreenImageView()) return;
            document.querySelectorAll('.lightboxed-content').forEach((el) => {
                if (el.dataset.rizWheelBound) return;
                el.dataset.rizWheelBound = '1';
                el.addEventListener('wheel', onCaptureWheel, WHEEL_OPTS);
            });
            const host = document.querySelector('shreddit-media-lightbox');
            const dialog = host?.shadowRoot?.querySelector('rpl-dialog');
            if (dialog && !dialog.dataset.rizWheelBound) {
                dialog.dataset.rizWheelBound = '1';
                dialog.addEventListener('wheel', onCaptureWheel, WHEEL_OPTS);
            }
        };

        const POST_MEDIA_CLICK = [
            'shreddit-media-lightbox-listener',
            'img.media-lightbox-img',
            'img.i18n-post-media-img',
            'img.preview-img',
            'shreddit-aspect-ratio',
            '.media-lightbox-img',
        ].join(', ');

        const onPostMediaClick = (e) => {
            if (isFullscreenImageView()) return;
            if (e.target.closest('#reddit-image-zoomer-controls')) return;
            if (!e.target.closest(POST_MEDIA_CLICK)) return;

            cachePostFromElement(e.target);

            // Never preventDefault — let Reddit handle the click first.
            // If the overlay didn't open, set #lightbox ourselves (Reddit listens on hashchange).
            setTimeout(() => {
                if (!isFullscreenImageView()) {
                    location.hash = 'lightbox';
                }
                markLightboxOpening();
                scheduleScan();
                setTimeout(scheduleScan, OPEN_GRACE_MS + 100);
            }, 50);
        };

        const NAV_ZONE_FRAC = 0.25;

        const isDirectImageHit = (e, img) => {
            const el = document.elementFromPoint(e.clientX, e.clientY) || e.target;
            return el === img || img.contains(el);
        };

        const isImageNavZone = (img, e) => {
            const r = img.getBoundingClientRect();
            if (r.width <= 0) return false;
            const relX = (e.clientX - r.left) / r.width;
            return relX < NAV_ZONE_FRAC || relX > (1 - NAV_ZONE_FRAC);
        };

        const isLightboxUiControl = (e) => {
            const control = e.target.closest?.(
                '#reddit-image-zoomer-controls, [aria-label="Close lightbox"], ' +
                '[aria-label="Next"], [aria-label="Previous"], ' +
                '[aria-label="Next page"], [aria-label="Previous page"], ' +
                'button, a[href], [role="button"]'
            );
            if (!control) return false;
            return !control.closest?.('#reddit-image-zoomer-controls');
        };

        const isLightboxInteractionTarget = (e) => {
            if (isLightboxUiControl(e)) return false;

            const img = findActiveLightboxImage();
            if (!img) return false;

            // Clicks on gallery carousel chrome (parent wrappers) — let Reddit navigate
            if (!isDirectImageHit(e, img)) return false;

            const scale = img._riz?.scale ?? 1;
            if (scale > 1) return true;

            // At 1×, Reddit uses the left/right thirds of the image for gallery nav
            if (isImageNavZone(img, e)) return false;

            return true;
        };

        const blockLightboxActivate = (e) => {
            if (!shouldIntercept()) return;
            if (!isLightboxInteractionTarget(e)) return;

            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
        };

        const onCaptureMouseDown = (e) => {
            if (e.button !== 0) return;
            if (!shouldIntercept()) return;
            if (!isLightboxInteractionTarget(e)) return;

            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();

            const img = findActiveLightboxImage();
            if (!img) return;

            const state = ensureZoomState(img);
            dragImg = img;
            state.dragging = true;
            state.startX = e.clientX - state.tx;
            state.startY = e.clientY - state.ty;
            updateImageCursor(img);
        };

        const onPanMouseMove = (e) => {
            if (!dragImg?._riz?.dragging) return;
            e.preventDefault();
            const state = dragImg._riz;
            state.tx = e.clientX - state.startX;
            state.ty = e.clientY - state.startY;
            applyTransform(dragImg);
        };

        const onPanMouseUp = () => {
            if (!dragImg?._riz?.dragging) return;
            dragImg._riz.dragging = false;
            updateImageCursor(dragImg);
            dragImg = null;
        };

        const disableLightboxImage = (img) => {
            if (!img?.hasAttribute('zoom-enabled')) return;
            img.removeAttribute('zoom-enabled');
            img.style.transform = '';
            img.style.transformOrigin = '';
            img.style.willChange = '';
            img.style.cursor = '';
            delete img._riz;
        };

        const enableLightboxImage = (img) => {
            if (!img || img.hasAttribute('zoom-enabled')) return;
            log('Found lightbox image, enabling zoom:', img.src?.slice(0, 80));
            img.setAttribute('zoom-enabled', 'true');
            img.classList.remove('cursor-zoom-in', 'cursor-zoom-out');
            ensureZoomState(img);
            captureBaseLayoutSize(img);
            updateImageCursor(img);
            if (!img.complete) {
                img.addEventListener('load', () => {
                    if (img._riz) {
                        delete img._riz.baseW;
                        delete img._riz.baseH;
                    }
                    captureBaseLayoutSize(img);
                    updateZoomPercentLabel();
                }, { once: true });
            }
        };

        const refreshLightboxImages = () => {
            findLightboxImages().filter(img => img.src).forEach((img) => {
                if (img.hasAttribute('zoom-enabled')) {
                    img.classList.remove('cursor-zoom-in', 'cursor-zoom-out');
                }
            });
        };

        const scanAndEnableLightboxImages = () => {
            updateInterceptorState();
            updateZoomControlsVisibility();

            if (!shouldIntercept()) {
                // Never reset image styles while Reddit is opening or #lightbox is active
                if (location.hash === '#lightbox' || Date.now() < openGraceUntil) {
                    return;
                }
                findLightboxImages().forEach(disableLightboxImage);
                return;
            }

            findLightboxImages().filter(img => img.src).forEach(enableLightboxImage);
            refreshLightboxImages();
            bindLightboxWheelTargets();
            const active = findActiveLightboxImage();
            if (DEBUG && active) {
                log('Active lightbox image:', active.src?.slice(0, 80));
            }
            if (active) {
                updateImageCursor(active);
                updateZoomPercentLabel();
            }
        };

        const activateInterceptors = () => {
            if (interceptorsActive) return;
            interceptorsActive = true;
            document.addEventListener('mousedown', onCaptureMouseDown, CAPTURE_OPTS);
            document.addEventListener('click', blockLightboxActivate, CAPTURE_OPTS);
            document.addEventListener('dblclick', blockLightboxActivate, CAPTURE_OPTS);
        };

        const deactivateInterceptors = () => {
            if (!interceptorsActive) return;
            interceptorsActive = false;
            document.removeEventListener('mousedown', onCaptureMouseDown, CAPTURE_OPTS);
            document.removeEventListener('click', blockLightboxActivate, CAPTURE_OPTS);
            document.removeEventListener('dblclick', blockLightboxActivate, CAPTURE_OPTS);
            if (dragImg?._riz?.dragging) {
                dragImg._riz.dragging = false;
                dragImg = null;
            }
        };

        const updateInterceptorState = () => {
            if (shouldIntercept()) {
                activateInterceptors();
            } else {
                deactivateInterceptors();
            }
        };

        let scanTimer = null;
        const scheduleScan = () => {
            if (scanTimer) return;
            scanTimer = setTimeout(() => {
                scanTimer = null;
                observeLightboxHost();
                scanAndEnableLightboxImages();
            }, 150);
        };

        // Track mouse and zoom state
        let isZoomed = false;
        let isDragging = false;
        let startX = 0;
        let startY = 0;
        let scrollLeft = 0;
        let scrollTop = 0;
        let lastClickTime = 0;
        const DOUBLE_CLICK_DELAY = 300; // ms
        let currentImageIndex = 0;
        let galleryImages = [];

        // Find all images in the gallery
        const updateGalleryImages = () => {
            galleryImages = findLightboxImages().filter(img => img.src);
            currentImageIndex = galleryImages.findIndex(img =>
                img.src === zoomContainer.querySelector('img')?.src
            );
        };

        // Handle drag with simple positioning
        const handleDragStart = (e) => {
            if (!isZoomed) return;
            isDragging = true;
            zoomContainer.style.cursor = 'grabbing';
            
            const img = zoomContainer.querySelector('img');
            if (img) {
                startX = e.clientX - parseInt(img.style.left);
                startY = e.clientY - parseInt(img.style.top);
                log('Started dragging at:', e.clientX, e.clientY);
            }
        };

        const handleDrag = (e) => {
            if (!isDragging) return;
            e.preventDefault();
            
            const img = zoomContainer.querySelector('img');
            if (img) {
                const x = e.clientX - startX;
                const y = e.clientY - startY;
                img.style.left = `${x}px`;
                img.style.top = `${y}px`;
            }
        };

        const handleDragEnd = () => {
            if (isDragging) {
                log('Stopped dragging');
                isDragging = false;
                if (isZoomed) {
                    zoomContainer.style.cursor = 'grab';
                }
            }
        };

        // Center image at natural size
        const centerImage = (img) => {
            if (!img) {
                log('Warning: Attempting to center null image');
                return;
            }
            
            const centerX = Math.max(0, (window.innerWidth - img.naturalWidth) / 2);
            const centerY = Math.max(0, (window.innerHeight - img.naturalHeight) / 2);
            
            log('Centering image at:', centerX, centerY);
            log('Natural dimensions:', img.naturalWidth, 'x', img.naturalHeight);
            
            img.style.cssText = `
                position: absolute;
                max-width: none;
                max-height: none;
                width: ${img.naturalWidth}px;
                height: ${img.naturalHeight}px;
                left: ${centerX}px;
                top: ${centerY}px;
            `;
        };

        // Handle zoom toggle with double-click requirement
        const toggleZoom = (e, img) => {
            const currentTime = Date.now();
            const isDoubleClick = (currentTime - lastClickTime) < DOUBLE_CLICK_DELAY;
            lastClickTime = currentTime;

            if (!isDoubleClick) return;

            if (!isZoomed) {
                e.stopPropagation();
                isZoomed = true;
                zoomContainer.style.display = 'block';
                zoomContainer.style.cursor = 'grab';
                
                log('Zooming in on image:', img.src);
                const zoomedImg = img.cloneNode();
                zoomedImg.onload = () => {
                    log('Zoomed image loaded, centering');
                    centerImage(zoomedImg);
                };
                zoomedImg.onerror = () => {
                    log('Error loading zoomed image');
                    isZoomed = false;
                    zoomContainer.style.display = 'none';
                };
                
                zoomedImg.src = img.src;
                zoomedImg.srcset = img.srcset;
                
                zoomContainer.innerHTML = '';
                zoomContainer.appendChild(zoomedImg);
                updateGalleryImages();
            } else {
                log('Zooming out');
                isZoomed = false;
                zoomContainer.style.display = 'none';
                zoomContainer.innerHTML = '';
            }
        };

        // Show next image in gallery
        const showNextImage = (e) => {
            if (!isZoomed) return;
            e.preventDefault();
            
            updateGalleryImages();
            if (galleryImages.length <= 1) {
                log('No more images in gallery');
                return;
            }
            
            currentImageIndex = (currentImageIndex + 1) % galleryImages.length;
            const nextImage = galleryImages[currentImageIndex];
            log('Showing next image:', currentImageIndex + 1, 'of', galleryImages.length);
            
            const zoomedImg = document.createElement('img');
            zoomedImg.onload = () => {
                log('Next image loaded, centering');
                centerImage(zoomedImg);
                zoomContainer.innerHTML = '';
                zoomContainer.appendChild(zoomedImg);
            };
            zoomedImg.onerror = () => {
                log('Error loading next image');
            };
            
            zoomedImg.src = nextImage.src;
            zoomedImg.srcset = nextImage.srcset;
        };

        // Create container for zoomed image
        const createZoomContainer = () => {
            const container = document.createElement('div');
            container.id = 'reddit-image-zoomer-container';
            container.style.cssText = `
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                overflow: hidden;
                z-index: 10000;
                cursor: zoom-in;
                display: none;
                background: rgba(0, 0, 0, 0.9);
            `;
            
            container.addEventListener('contextmenu', showNextImage);
            document.body.appendChild(container);
            return container;
        };

        const zoomContainer = createZoomContainer();
        createZoomControls();

        const observedShadowRoots = new WeakSet();
        const observeShadowRoot = (root) => {
            if (!root || observedShadowRoots.has(root)) return;
            observedShadowRoots.add(root);
            const shadowObserver = new MutationObserver(() => scheduleScan());
            shadowObserver.observe(root, {
                childList: true,
                subtree: true,
            });
        };

        const observeLightboxHost = () => {
            const host = document.querySelector('shreddit-media-lightbox');
            if (host?.shadowRoot) observeShadowRoot(host.shadowRoot);
        };

        const observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                if (mutation.type !== 'childList') continue;
                for (const node of mutation.addedNodes) {
                    if (node.nodeType !== 1) continue;
                    if (node.matches?.('img.media-lightbox-img, .lightboxed-content, .lightboxed-content img, shreddit-media-lightbox, [aria-label="Close lightbox"]')
                        || node.querySelector?.('img.media-lightbox-img, .lightboxed-content img, shreddit-media-lightbox, [aria-label="Close lightbox"]')) {
                        scheduleScan();
                        return;
                    }
                }
                for (const node of mutation.removedNodes) {
                    if (node.nodeType !== 1) continue;
                    if (node.matches?.('[aria-label="Close lightbox"]')
                        || node.querySelector?.('[aria-label="Close lightbox"]')) {
                        handleLightboxClose();
                        return;
                    }
                }
            }
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true,
        });

        document.addEventListener('mousemove', onPanMouseMove);
        document.addEventListener('mouseup', onPanMouseUp);
        document.addEventListener('mouseleave', onPanMouseUp);
        document.addEventListener('click', onPostMediaClick, { passive: true });

        document.addEventListener('click', (e) => {
            if (e.target.closest?.('[aria-label="Close lightbox"]')) {
                setTimeout(handleLightboxClose, 0);
            }
        }, true);

        window.addEventListener('popstate', () => scheduleScan());

        window.addEventListener('hashchange', () => {
            if (location.hash === '#lightbox') {
                markLightboxOpening();
            } else {
                handleLightboxClose();
            }
            scheduleScan();
            setTimeout(scheduleScan, 100);
            setTimeout(scheduleScan, OPEN_GRACE_MS + 100);
        });

        log('Zoom handler initialized');

        // Add event listeners for drag
        zoomContainer.addEventListener('mousedown', handleDragStart);
        document.addEventListener('mousemove', handleDrag);
        document.addEventListener('mouseup', handleDragEnd);
        document.addEventListener('mouseleave', handleDragEnd);

        // Close zoom on escape key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && isZoomed) {
                isZoomed = false;
                zoomContainer.style.display = 'none';
                zoomContainer.innerHTML = '';
            }
        });

        observeLightboxHost();
        ensureWheelListener();
        if (isFullscreenImageView()) {
            openGraceUntil = 0;
        } else if (location.hash === '#lightbox') {
            markLightboxOpening();
        }
        scheduleScan();
    };

    const initPotPlayerLinks = () => {
        const MARK = 'data-riz-potplayer';
        const STYLE_ID = 'reddit-image-zoomer-potplayer-style';

        const walkShadowDeep = (root, visit) => {
            if (!root?.querySelectorAll) return;
            visit(root);
            for (const el of root.querySelectorAll('*')) {
                if (el.shadowRoot) walkShadowDeep(el.shadowRoot, visit);
            }
        };

        const findYoutubeIframe = (post) => {
            let found = null;
            walkShadowDeep(post, (node) => {
                if (found) return;
                found = node.querySelector('iframe[src*="youtube.com/embed"], iframe[src*="youtube-nocookie.com/embed"]');
            });
            return found;
        };

        const normalizeYoutubeUrl = (raw) => {
            if (!raw) return null;
            try {
                const u = new URL(raw, location.origin);
                const host = u.hostname.replace(/^www\./, '');
                if (host === 'youtu.be') {
                    const id = u.pathname.split('/').filter(Boolean)[0];
                    return id ? `https://www.youtube.com/watch?v=${id}` : null;
                }
                if (host === 'youtube.com' || host === 'm.youtube.com') {
                    const id = u.searchParams.get('v')
                        || u.pathname.match(/\/embed\/([^/?]+)/)?.[1]
                        || u.pathname.match(/\/shorts\/([^/?]+)/)?.[1];
                    return id ? `https://www.youtube.com/watch?v=${id}` : null;
                }
            } catch {
                return null;
            }
            return null;
        };

        const decodeHtmlAttr = (value) => {
            const ta = document.createElement('textarea');
            ta.innerHTML = value;
            return ta.value;
        };

        const formatPlaybackTime = (seconds) => {
            const total = Math.max(0, Math.floor(seconds));
            const h = Math.floor(total / 3600);
            const m = Math.floor((total % 3600) / 60);
            const s = total % 60;
            if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
            return `${m}:${String(s).padStart(2, '0')}`;
        };

        const buildPotPlayerUrl = (watchUrl, seconds) => {
            const u = new URL(watchUrl);
            if (seconds > 0.5) {
                u.searchParams.set('t', String(Math.floor(seconds)));
            } else {
                u.searchParams.delete('t');
            }
            return `potplayer://${u.toString()}`;
        };

        const patchYoutubeIframe = (iframe) => {
            if (!iframe || iframe.dataset.rizYtPatched) return;
            const src = iframe.getAttribute('src') || '';
            if (!src.includes('youtube.com/embed') && !src.includes('youtube-nocookie.com/embed')) return;
            if (src.includes('enablejsapi=1')) {
                iframe.dataset.rizYtPatched = '1';
                return;
            }
            try {
                const u = new URL(src, location.origin);
                u.searchParams.set('enablejsapi', '1');
                u.searchParams.set('origin', location.origin);
                iframe.src = u.toString();
            } catch {
                return;
            }
            iframe.dataset.rizYtPatched = '1';
        };

        const ytCommand = (iframe, func, args = []) => {
            iframe.contentWindow?.postMessage(JSON.stringify({
                event: 'command',
                func,
                args,
            }), '*');
        };

        const getYoutubeCurrentTime = (iframe, timeoutMs = 500) => new Promise((resolve) => {
            let settled = false;
            const finish = (value) => {
                if (settled) return;
                settled = true;
                window.removeEventListener('message', onMessage);
                clearTimeout(timer);
                resolve(Math.max(0, Number(value) || 0));
            };

            const onMessage = (event) => {
                if (event.source !== iframe.contentWindow) return;
                try {
                    const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
                    if (data?.info?.currentTime != null) {
                        finish(data.info.currentTime);
                    }
                } catch {
                    // ignore non-JSON postMessages
                }
            };

            window.addEventListener('message', onMessage);
            const timer = setTimeout(() => finish(0), timeoutMs);

            try {
                iframe.contentWindow.postMessage(JSON.stringify({ event: 'listening' }), '*');
                ytCommand(iframe, 'getCurrentTime');
            } catch {
                finish(0);
            }
        });

        const getNativeVideo = (post) => {
            let found = null;
            walkShadowDeep(post, (node) => {
                if (found) return;
                const video = node.querySelector('video');
                if (video && !Number.isNaN(video.currentTime)) found = video;
            });
            return found;
        };

        const getPostPlaybackSeconds = async (post) => {
            const video = getNativeVideo(post);
            if (video) return video.currentTime;

            const iframe = findYoutubeIframe(post);
            if (iframe) return getYoutubeCurrentTime(iframe);
            return 0;
        };

        const pausePostPlayback = (post) => {
            const video = getNativeVideo(post);
            if (video) {
                video.pause();
                return;
            }
            const iframe = findYoutubeIframe(post);
            if (iframe) ytCommand(iframe, 'pauseVideo');
        };

        const patchPostYoutubeIframes = (post) => {
            walkShadowDeep(post, (node) => {
                node.querySelectorAll('iframe[src*="youtube.com/embed"], iframe[src*="youtube-nocookie.com/embed"]')
                    .forEach(patchYoutubeIframe);
            });
        };

        const handlePotPlayerClick = async (event, post, watchUrl, link) => {
            event.preventDefault();
            event.stopPropagation();

            const seconds = await getPostPlaybackSeconds(post);
            pausePostPlayback(post);

            const potUrl = buildPotPlayerUrl(watchUrl, seconds);
            link.title = seconds > 0.5
                ? `${watchUrl} (resume ${formatPlaybackTime(seconds)})`
                : watchUrl;

            window.location.href = potUrl;
        };

        const bindPotPlayerLink = (link, post, watchUrl) => {
            link.dataset.rizWatchUrl = watchUrl;
            link.href = buildPotPlayerUrl(watchUrl, 0);
            if (link.dataset.rizClickBound) return;
            link.dataset.rizClickBound = '1';
            link.addEventListener('click', (e) => handlePotPlayerClick(e, post, watchUrl, link));
        };

        const extractYoutubeFromPost = (post) => {
            const contentHref = post.getAttribute('content-href');
            const fromContent = normalizeYoutubeUrl(contentHref);
            if (fromContent) return fromContent;

            const embed = post.querySelector('shreddit-embed');
            if (embed) {
                const provider = (embed.getAttribute('providername') || '').toLowerCase();
                if (provider === 'youtube') {
                    const html = embed.getAttribute('html') || '';
                    const decoded = decodeHtmlAttr(html);
                    const src = decoded.match(/\bsrc=["']([^"']+)["']/i)?.[1];
                    const fromEmbed = normalizeYoutubeUrl(src);
                    if (fromEmbed) return fromEmbed;
                }
            }

            const link = post.querySelector('a[href*="youtube.com"], a[href*="youtu.be"]');
            return link ? normalizeYoutubeUrl(link.href) : null;
        };

        const ensureStyles = () => {
            if (document.getElementById(STYLE_ID)) return;
            const style = document.createElement('style');
            style.id = STYLE_ID;
            style.textContent = `
                .riz-potplayer-wrap {
                    display: block;
                    margin: 10px 16px 6px;
                    position: relative;
                    z-index: 2;
                }
                .riz-potplayer-link {
                    display: inline-flex;
                    align-items: center;
                    gap: 6px;
                    padding: 6px 12px;
                    border-radius: 999px;
                    background: color-mix(in srgb, var(--color-neutral-background-strong, #333) 80%, transparent);
                    border: 1px solid color-mix(in srgb, var(--color-neutral-content, #fff) 20%, transparent);
                    color: var(--color-neutral-content-strong, #fff);
                    font: 600 12px/1.2 system-ui, -apple-system, sans-serif;
                    text-decoration: none;
                }
                .riz-potplayer-link:hover {
                    background: rgba(255, 255, 255, 0.16);
                    text-decoration: none;
                }
            `;
            document.head.appendChild(style);
        };

        const findInsertPoint = (post) => (
            post.querySelector('div.relative.overflow-hidden.pointer-cursor')
            || post.querySelector('[slot="post-media-container"]')
            || post.querySelector('shreddit-aspect-ratio')
            || post.querySelector('shreddit-embed')?.closest('div[class*="overflow-hidden"]')
            || post.querySelector('shreddit-embed')
            || post.querySelector('shreddit-player')?.closest('div')
        );

        const attachPotPlayerLink = (post) => {
            patchPostYoutubeIframes(post);

            if (post.getAttribute(MARK) === 'done') return;

            const watchUrl = extractYoutubeFromPost(post);
            if (!watchUrl) return;

            const existing = post.querySelector('.riz-potplayer-link');
            if (existing) {
                bindPotPlayerLink(existing, post, watchUrl);
                post.setAttribute(MARK, 'done');
                return;
            }

            const insertPoint = findInsertPoint(post);
            if (!insertPoint) return;

            const wrap = document.createElement('div');
            wrap.className = 'riz-potplayer-wrap';

            const link = document.createElement('a');
            link.className = 'riz-potplayer-link';
            link.textContent = 'Open in PotPlayer';
            bindPotPlayerLink(link, post, watchUrl);
            wrap.appendChild(link);

            insertPoint.insertAdjacentElement('afterend', wrap);
            post.setAttribute(MARK, 'done');
            log('PotPlayer link added:', watchUrl);
        };

        let scanTimer = null;
        const scanPosts = () => {
            document.querySelectorAll('shreddit-post').forEach(attachPotPlayerLink);
        };
        const scheduleScan = () => {
            if (scanTimer) return;
            scanTimer = setTimeout(() => {
                scanTimer = null;
                scanPosts();
            }, 150);
        };

        ensureStyles();
        scanPosts();
        [500, 1500, 3000, 6000].forEach((ms) => setTimeout(scanPosts, ms));

        const observer = new MutationObserver((mutations) => {
            let needsScan = false;
            for (const mutation of mutations) {
                if (mutation.type === 'attributes') {
                    const post = mutation.target.matches?.('shreddit-post')
                        ? mutation.target
                        : mutation.target.closest?.('shreddit-post');
                    if (post) {
                        post.removeAttribute(MARK);
                        needsScan = true;
                    }
                    continue;
                }
                if (mutation.type !== 'childList') continue;
                for (const node of mutation.addedNodes) {
                    if (node.nodeType !== 1) continue;
                    if (node.matches?.('iframe[src*="youtube.com/embed"], iframe[src*="youtube-nocookie.com/embed"]')) {
                        patchYoutubeIframe(node);
                    }
                    if (node.matches?.('shreddit-post, shreddit-embed, shreddit-async-loader, iframe')
                        || node.querySelector?.('shreddit-post, shreddit-embed, shreddit-async-loader, iframe[src*="youtube"]')) {
                        needsScan = true;
                        break;
                    }
                }
            }
            if (needsScan) scheduleScan();
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['content-href', 'html', 'providername'],
        });

        log('PotPlayer link handler initialized');
    };

    const initTitleFilter = () => {
        const STORAGE_KEY = 'riz-title-filters';
        const FILTERED_ATTR = 'data-riz-title-filtered';
        const FILTERED_CLASS = 'riz-title-filtered';

        let filterTerms = [];
        let panelOpen = false;
        let scanTimer = null;

        const normalizeTerms = (value) => {
            if (Array.isArray(value)) {
                return value.map((t) => String(t).trim()).filter(Boolean);
            }
            if (typeof value === 'string') {
                const trimmed = value.trim();
                if (!trimmed) return [];
                try {
                    const parsed = JSON.parse(trimmed);
                    if (Array.isArray(parsed)) {
                        return parsed.map((t) => String(t).trim()).filter(Boolean);
                    }
                } catch {
                    // treat as newline-separated text
                }
                return trimmed.split(/\r?\n/).map((t) => t.trim()).filter(Boolean);
            }
            return [];
        };

        // Persist as a JSON string so it always shows in Tampermonkey's Storage tab
        // and survives sync/export reliably (arrays can be flaky across TM storage reworks).
        const serializeTerms = (terms) => JSON.stringify(normalizeTerms(terms));

        const gmAvailable = () => (
            typeof GM_getValue === 'function' && typeof GM_setValue === 'function'
        );

        const loadFilters = () => {
            let stored = null;
            if (gmAvailable()) {
                try {
                    stored = GM_getValue(STORAGE_KEY, null);
                } catch (err) {
                    console.warn('[Reddit Image Zoomer] GM_getValue failed:', err);
                }
            } else {
                console.warn('[Reddit Image Zoomer] GM_getValue/GM_setValue unavailable — re-save the script in Tampermonkey so @grant applies');
            }

            if (stored == null || stored === '') {
                // One-time migrate from older localStorage installs
                try {
                    const legacy = localStorage.getItem(STORAGE_KEY);
                    if (legacy) {
                        filterTerms = normalizeTerms(legacy);
                        saveFilters(filterTerms);
                        localStorage.removeItem(STORAGE_KEY);
                        log('Migrated title filters from localStorage to GM storage');
                        return;
                    }
                } catch {
                    // ignore
                }
                filterTerms = [];
                return;
            }

            filterTerms = normalizeTerms(stored);
            // Older builds stored a raw array; rewrite as JSON string for Storage/sync.
            if (Array.isArray(stored)) {
                saveFilters(filterTerms);
            }
        };

        const saveFilters = (terms) => {
            filterTerms = normalizeTerms(terms);
            const payload = serializeTerms(filterTerms);
            if (!gmAvailable()) {
                console.warn('[Reddit Image Zoomer] Cannot save filters — GM storage unavailable');
                return;
            }
            try {
                GM_setValue(STORAGE_KEY, payload);
                // Confirm write landed in script storage (what TM sync/export uses)
                const roundTrip = GM_getValue(STORAGE_KEY, null);
                if (roundTrip !== payload) {
                    console.warn('[Reddit Image Zoomer] GM_setValue did not persist filters', { payload, roundTrip });
                } else {
                    log('Saved title filters to GM storage:', filterTerms);
                }
            } catch (err) {
                console.warn('[Reddit Image Zoomer] GM_setValue failed:', err);
            }
        };

        const getPostTitleText = (post) => (
            post.getAttribute('post-title')?.trim()
            || post.querySelector('a[id^="post-title-"]')?.textContent?.trim()
            || post.querySelector('h1[id^="post-title-"]')?.textContent?.trim()
            || post.querySelector('[slot="title"]')?.textContent?.trim()
            || ''
        );

        const titleMatchesFilter = (title) => {
            if (!title || !filterTerms.length) return false;
            const hay = title.toLowerCase();
            return filterTerms.some((term) => hay.includes(term.toLowerCase()));
        };

        const hideTargetForPost = (post) => (
            post.closest('article[data-post-id], article')
            || post.closest('[data-testid="post-container"]')
            || post
        );

        const clearFilteredMark = (post) => {
            const target = hideTargetForPost(post);
            target.classList.remove(FILTERED_CLASS);
            target.removeAttribute(FILTERED_ATTR);
            if (target !== post) {
                post.classList.remove(FILTERED_CLASS);
                post.removeAttribute(FILTERED_ATTR);
            }
        };

        const applyFilterToPost = (post) => {
            if (!post?.matches?.('shreddit-post')) return;
            const title = getPostTitleText(post);
            const target = hideTargetForPost(post);
            if (titleMatchesFilter(title)) {
                target.classList.add(FILTERED_CLASS);
                target.setAttribute(FILTERED_ATTR, '1');
                post.setAttribute(FILTERED_ATTR, '1');
                log('Filtered post:', post.id, title);
            } else {
                clearFilteredMark(post);
            }
        };

        const scanAllPosts = () => {
            document.querySelectorAll('shreddit-post').forEach(applyFilterToPost);
            updateHiddenCount();
        };

        const scheduleFilterScan = () => {
            if (scanTimer) return;
            scanTimer = setTimeout(() => {
                scanTimer = null;
                scanAllPosts();
            }, 120);
        };

        const updateHiddenCount = () => {
            const badge = document.querySelector('#riz-title-filter-btn .riz-filter-count');
            if (!badge) return;
            const n = document.querySelectorAll(`shreddit-post[${FILTERED_ATTR}]`).length;
            badge.textContent = String(n);
            badge.hidden = n === 0;
        };

        const createFilterUi = () => {
            document.getElementById('riz-title-filter-root')?.remove();

            const style = document.createElement('style');
            style.id = 'riz-title-filter-style';
            style.textContent = `
                .riz-title-filtered,
                [${FILTERED_ATTR}="1"].riz-title-filtered {
                    display: none !important;
                }
                #riz-title-filter-root {
                    position: fixed;
                    left: 16px;
                    bottom: 16px;
                    z-index: 10002;
                    font-family: system-ui, -apple-system, sans-serif;
                }
                #riz-title-filter-btn {
                    display: inline-flex;
                    align-items: center;
                    gap: 8px;
                    height: 44px;
                    padding: 0 14px;
                    border: 1px solid rgba(255, 255, 255, 0.15);
                    border-radius: 10px;
                    background: rgba(0, 0, 0, 0.72);
                    color: #fff;
                    font-size: 13px;
                    font-weight: 600;
                    cursor: pointer;
                    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.45);
                }
                #riz-title-filter-btn:hover {
                    background: rgba(0, 0, 0, 0.85);
                }
                #riz-title-filter-btn .riz-filter-count {
                    min-width: 20px;
                    padding: 2px 6px;
                    border-radius: 999px;
                    background: rgba(255, 255, 255, 0.18);
                    font-size: 12px;
                    text-align: center;
                }
                #riz-title-filter-panel {
                    display: none;
                    position: absolute;
                    left: 0;
                    bottom: 52px;
                    width: min(360px, calc(100vw - 32px));
                    padding: 12px;
                    border-radius: 12px;
                    background: rgba(20, 20, 20, 0.96);
                    border: 1px solid rgba(255, 255, 255, 0.15);
                    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
                    color: #fff;
                }
                #riz-title-filter-panel.open {
                    display: block;
                }
                #riz-title-filter-panel h2 {
                    margin: 0 0 6px;
                    font-size: 14px;
                    font-weight: 700;
                }
                #riz-title-filter-panel p {
                    margin: 0 0 10px;
                    font-size: 12px;
                    line-height: 1.35;
                    color: rgba(255, 255, 255, 0.7);
                }
                #riz-title-filter-panel textarea {
                    box-sizing: border-box;
                    width: 100%;
                    min-height: 160px;
                    margin: 0 0 10px;
                    padding: 8px 10px;
                    border-radius: 8px;
                    border: 1px solid rgba(255, 255, 255, 0.2);
                    background: rgba(0, 0, 0, 0.45);
                    color: #fff;
                    font: 13px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
                    resize: vertical;
                }
                #riz-title-filter-panel .riz-filter-actions {
                    display: flex;
                    gap: 8px;
                    justify-content: flex-end;
                }
                #riz-title-filter-panel .riz-filter-actions button {
                    height: 34px;
                    padding: 0 12px;
                    border: none;
                    border-radius: 8px;
                    background: rgba(255, 255, 255, 0.14);
                    color: #fff;
                    font-size: 13px;
                    font-weight: 600;
                    cursor: pointer;
                }
                #riz-title-filter-panel .riz-filter-actions button.primary {
                    background: rgba(255, 255, 255, 0.28);
                }
                #riz-title-filter-panel .riz-filter-actions button:hover {
                    background: rgba(255, 255, 255, 0.22);
                }
                #riz-title-filter-panel .riz-filter-actions button.primary:hover {
                    background: rgba(255, 255, 255, 0.36);
                }
            `;
            document.head.appendChild(style);

            const root = document.createElement('div');
            root.id = 'riz-title-filter-root';
            root.innerHTML = `
                <div id="riz-title-filter-panel" role="dialog" aria-label="Title filter options">
                    <h2>Title filters</h2>
                    <p>One phrase per line. Posts whose titles contain a phrase (case-insensitive) are hidden as the feed loads.</p>
                    <textarea id="riz-title-filter-input" spellcheck="false" placeholder="trump&#10;elon&#10;world cup"></textarea>
                    <div class="riz-filter-actions">
                        <button type="button" class="riz-filter-clear">Clear</button>
                        <button type="button" class="riz-filter-apply primary">Apply</button>
                    </div>
                </div>
                <button type="button" id="riz-title-filter-btn" title="Edit title filters" aria-label="Edit title filters">
                    Filters
                    <span class="riz-filter-count" hidden>0</span>
                </button>
            `;
            document.body.appendChild(root);

            const panel = root.querySelector('#riz-title-filter-panel');
            const input = root.querySelector('#riz-title-filter-input');
            const btn = root.querySelector('#riz-title-filter-btn');

            const syncTextarea = () => {
                input.value = filterTerms.join('\n');
            };

            const setPanelOpen = (open) => {
                panelOpen = open;
                panel.classList.toggle('open', open);
                if (open) {
                    syncTextarea();
                    input.focus();
                }
            };

            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                setPanelOpen(!panelOpen);
            });

            root.querySelector('.riz-filter-apply').addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                saveFilters(input.value.split(/\r?\n/));
                scanAllPosts();
                setPanelOpen(false);
                log('Title filters applied:', filterTerms);
            });

            root.querySelector('.riz-filter-clear').addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                input.value = '';
                saveFilters([]);
                scanAllPosts();
            });

            panel.addEventListener('click', (e) => e.stopPropagation());
            panel.addEventListener('mousedown', (e) => e.stopPropagation());

            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && panelOpen) {
                    setPanelOpen(false);
                }
            });

            syncTextarea();
            return root;
        };

        loadFilters();
        createFilterUi();
        scanAllPosts();

        if (typeof GM_addValueChangeListener === 'function') {
            GM_addValueChangeListener(STORAGE_KEY, (_name, _oldValue, newValue, remote) => {
                if (!remote) return;
                filterTerms = normalizeTerms(newValue);
                const input = document.querySelector('#riz-title-filter-input');
                if (input && !panelOpen) {
                    input.value = filterTerms.join('\n');
                }
                scanAllPosts();
                log('Title filters updated from another tab:', filterTerms);
            });
        }

        const observer = new MutationObserver((mutations) => {
            let needsScan = false;
            for (const mutation of mutations) {
                if (mutation.type === 'attributes') {
                    if (mutation.target?.matches?.('shreddit-post')) {
                        applyFilterToPost(mutation.target);
                        needsScan = true;
                    }
                    continue;
                }
                if (mutation.type !== 'childList') continue;
                for (const node of mutation.addedNodes) {
                    if (node.nodeType !== 1) continue;
                    if (node.matches?.('shreddit-post') || node.querySelector?.('shreddit-post')) {
                        needsScan = true;
                        break;
                    }
                }
                if (needsScan) break;
            }
            if (needsScan) scheduleFilterScan();
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['post-title'],
        });

        log('Title filter initialized', filterTerms.length, 'terms');
    };

    const safeInit = (fn, label) => {
        try {
            fn();
        } catch (err) {
            console.error('[Reddit Image Zoomer]', label, 'failed:', err);
        }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            safeInit(initZoomHandler, 'zoom handler');
            safeInit(initPotPlayerLinks, 'PotPlayer links');
            safeInit(initTitleFilter, 'title filter');
        });
        log('Waiting for DOM to be ready');
    } else {
        safeInit(initZoomHandler, 'zoom handler');
        safeInit(initPotPlayerLinks, 'PotPlayer links');
        safeInit(initTitleFilter, 'title filter');
        log('DOM already ready, initializing immediately');
    }
})();

