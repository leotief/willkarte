// willkarte — map (runs inside the extension iframe)
// Receives listings from the content script via postMessage and plots them as
// Airbnb-style price pills on a Leaflet + MapLibre (vector) map.
//
// Display model:
//  - Flats at (almost) the same spot merge into a "unit": one flat shows its
//    price, several show the cheapest + a "+N" badge with ‹ › arrows in the popup.
//    The merge threshold is fixed real-world distance (projected at COINCIDE_ZOOM),
//    so it never merges flats that separate as you zoom in.
//  - A slider-controlled number of pills is placed greedily from the view centre
//    outwards; they don't overlap until you ask for more than fit.
//  - Units without a pill are hinted with small empty "density dots".
//  - Popups open on CLICK of the pill (click the pill again, or the map, to close).
//  - The view is reconciled on pan/zoom, so open popups survive.

(function () {
  "use strict";

  const AUSTRIA = [47.6, 13.3];
  // Min gap between pill centres (screen px), rectangular: pills stack tightly in
  // rows but never side-swipe.
  const PILL_W = 86;
  const PILL_H = 30;
  // Pill cap, driven by the top-bar slider. Past what fits collision-free the extras
  // are drawn overlapping rather than dropped.
  let maxPills = 50;
  const DOT_CELL = 46; // coarse grid for density dots (screen px)
  const COINCIDE_ZOOM = 18; // reference zoom for "same spot" test
  const COINCIDE_PX = 22; // <= this many px apart at that zoom => same spot

  const map = L.map("map", { zoomControl: true, attributionControl: false }).setView(AUSTRIA, 7);

  // Density-dot pane below the default marker pane (600), so dots always render
  // beneath the price pills.
  map.createPane("wkDots");
  map.getPane("wkDots").style.zIndex = 550;

  // ---- Basemap (vector, with raster fallback) ---------------------------
  const ATTR =
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
  const RASTER = [
    {
      url: "https://{s}.basemap.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
      opts: { subdomains: "abcd", maxZoom: 20, attribution: ATTR + " &copy; CARTO" },
    },
    {
      url: "https://tile.openstreetmap.de/{z}/{x}/{y}.png",
      opts: { maxZoom: 19, attribution: ATTR },
    },
    {
      url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
      opts: { subdomains: "abc", maxZoom: 19, attribution: ATTR },
    },
  ];
  let tileLayer = null;
  function useRaster(i = 0) {
    if (i >= RASTER.length) return;
    if (tileLayer) map.removeLayer(tileLayer);
    let errors = 0;
    tileLayer = L.tileLayer(RASTER[i].url, RASTER[i].opts);
    tileLayer.on("tileerror", () => {
      if (++errors > 4 && i < RASTER.length - 1) useRaster(i + 1);
    });
    tileLayer.addTo(map);
  }
  try {
    if (typeof maplibregl === "undefined" || typeof L.maplibreGL !== "function")
      throw new Error("maplibre-gl not loaded");
    const gl = L.maplibreGL({
      style: "https://tiles.openfreemap.org/styles/bright",
      attribution:
        '&copy; <a href="https://openfreemap.org">OpenFreeMap</a> ' +
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);

    // If the vector engine can't run (e.g. a CSP blocking MapLibre's worker) it
    // errors before rendering — fall back to raster. A slow load is NOT an error,
    // so a working/still-loading vector map is left alone.
    const glMap = gl.getMaplibreMap && gl.getMaplibreMap();
    if (glMap) {
      glMap.on("error", (ev) => {
        if (glMap.loaded()) return; // already worked — ignore later tile hiccups
        const msg = (ev && ev.error && ev.error.message) || "";
        if (!/worker|blob|security|content security|not allowed|failed to construct/i.test(msg))
          return;
        console.log("[willkarte] vector engine blocked — using raster:", msg);
        map.removeLayer(gl);
        useRaster();
      });
    }
  } catch (e) {
    console.log("[willkarte] vector basemap unavailable, using raster:", e);
    useRaster();
  }

  const layer = L.layerGroup().addTo(map); // pills + dots (reconciled)
  const empty = document.getElementById("wk-empty");

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
    }[c]));
  }
  function priceAsc(a, b) {
    return (a.priceNum == null ? Infinity : a.priceNum) - (b.priceNum == null ? Infinity : b.priceNum);
  }

  // ---- Merkliste state (mirrors willhaben's, kept by the content script) --
  let savedIds = new Set();
  let canSave = false; // false when signed out — then no stars at all
  // Elements whose "is-saved" class follows the Merkliste. A group pill watches
  // every flat at its spot (it shows a star if any of them is saved), a single
  // pill or a popup star watches just one.
  let starTargets = [];

  function isSaved(l) {
    return savedIds.has(String(l.id));
  }

  // ---- Hidden state (our own, kept by the content script in storage.local) --
  let hiddenIds = new Set();
  // View filter, driven by the top-bar "Ansicht" menu: three independent on/off
  // switches, one per listing category. A flat is drawn if its category is on.
  //   starred   — Merkliste flats                    (default on)
  //   hidden    — hidden flats (shown dimmed when on) (default off)
  //   untouched — neither starred nor hidden          (default on)
  // A hidden flat counts as "hidden" even if also starred (hidden wins).
  let view = { starred: true, hidden: false, untouched: true };
  function category(l) {
    if (isHidden(l)) return "hidden";
    if (isSaved(l)) return "starred";
    return "untouched";
  }
  // Elements whose "is-hidden" class follows the hidden set (the eye button in a
  // popup, and a revealed pill). A group watches every flat at its spot.
  let hideTargets = [];

  function isHidden(l) {
    return hiddenIds.has(String(l.id));
  }
  function trackHide(el, flats) {
    const ids = flats.map((l) => String(l.id));
    hideTargets.push({ el, ids });
    el.classList.toggle("is-hidden", ids.some((id) => hiddenIds.has(id)));
  }
  function paintHidden() {
    hideTargets = hideTargets.filter((t) => t.el.isConnected);
    for (const t of hideTargets)
      t.el.classList.toggle("is-hidden", t.ids.some((id) => hiddenIds.has(id)));
    syncButtonLocks();
  }
  // Optimistic: flip now, ask the content script to persist. It answers with the
  // true set, so a failed write snaps back.
  function toggleHidden(l) {
    const want = !isHidden(l);
    if (want) hiddenIds.add(String(l.id));
    else hiddenIds.delete(String(l.id));
    paintHidden();
    parent.postMessage({ type: "willkarte:hide", id: l.id, hide: want }, "*");
    render(lastListings, lastLoadId); // vanish/reappear immediately
  }
  function trackStar(el, flats) {
    const ids = flats.map((l) => String(l.id));
    starTargets.push({ el, ids });
    el.classList.toggle("is-saved", ids.some((id) => savedIds.has(id)));
  }
  function paintStars() {
    starTargets = starTargets.filter((t) => t.el.isConnected); // drop removed markers
    for (const t of starTargets)
      t.el.classList.toggle("is-saved", t.ids.some((id) => savedIds.has(id)));
    syncButtonLocks();
  }

  // Star and hide are opposites: a flat can be one or the other, not both. In the
  // open popup each button is disabled while the other state is set, so switching
  // means first clearing the current one.
  let popupButtons = null; // { star, eye, flat } of the open popup, or null
  function syncButtonLocks() {
    if (!popupButtons || !popupButtons.star.isConnected) return;
    const l = popupButtons.flat();
    const saved = isSaved(l);
    const hid = isHidden(l);
    popupButtons.eye.disabled = saved; // starred → can't hide
    popupButtons.star.disabled = hid; // hidden → can't star
  }
  // Optimistic: flip the star now, and ask the content script to do the real call.
  // It always answers with the true state, so a failure snaps the star back.
  function toggleSaved(l) {
    const want = !isSaved(l);
    if (want) savedIds.add(String(l.id));
    else savedIds.delete(String(l.id));
    paintStars();
    parent.postMessage({ type: "willkarte:save", id: l.id, save: want }, "*");
  }

  // ---- Popup content ----------------------------------------------------
  // One builder for both cases: a photo gallery of the current listing, plus — when
  // several flats share the spot — a bar above the image to page between listings.
  // "2" -> "2. Stock", "EG"/"0" -> "EG", anything already worded passes through.
  function floorLabel(v) {
    const s = String(v).trim();
    if (!s) return null;
    if (/^(eg|erdgeschoss|0)$/i.test(s)) return "EG";
    if (/^\d+$/.test(s)) return s + ". Stock";
    return s;
  }

  // Availability lives only on the ad's detail page (see content.js), so it's
  // fetched lazily when a popup opens. State per id: undefined = not yet asked,
  // "pending" = fetching, null = fetched, none given, string = the value.
  const availById = new Map();
  // Always "Verfügbar: " + whatever willhaben gives, verbatim (e.g. "ab sofort",
  // "05.09.2026"). No reformatting.
  function availLabel(v) {
    const s = String(v).trim();
    if (!s) return null;
    return "Verfügbar: " + s;
  }
  // Ask the content script (which has the willhaben origin + cookies) to fetch this
  // ad's detail page and return its availability. Only the first ask per id hits it.
  function requestAvail(l) {
    if (availById.has(l.id) || !l.url) return;
    availById.set(l.id, "pending");
    parent.postMessage({ type: "willkarte:fetchDetail", id: l.id, url: l.url }, "*");
  }
  // The availability text for a flat, given its fetch state. Rendered as plain text
  // that continues the specs line (a "· " divider is added by CSS), just coloured
  // differently. While loading, the value is animated dots.
  function availChip(l) {
    const st = availById.get(l.id);
    if (st === undefined || st === "pending")
      return 'Verfügbar: <span class="wk-avail-dots"></span>';
    const label = st ? availLabel(st) : null;
    return label ? esc(label) : "";
  }

  function detailsHtml(l) {
    const floor = l.floor ? floorLabel(l.floor) : null;
    const specs = [
      parseFloat(l.rooms) > 0 ? l.rooms + " Zi." : null,
      l.size ? l.size + " m²" : null,
      floor,
    ].filter(Boolean).join(" · ");
    return (
      // Price · specs, then the availability chip — all left-aligned on the top
      // line, so it stays clear of the star/hide buttons at the right edge.
      '<div class="wk-pop-head">' +
        '<span class="wk-pop-price">' + esc(l.priceDisplay) + "</span>" +
        (specs ? '<span class="wk-pop-specs">' + esc(specs) + "</span>" : "") +
        '<span class="wk-pop-availrow">' + availChip(l) + "</span>" +
      "</div>" +
      (l.address ? '<div class="wk-pop-addr">' + esc(l.address) + "</div>" : "") +
      (l.title ? '<div class="wk-pop-title">' + esc(l.title) + "</div>" : "")
    );
  }

  function navButton(glyph, cls) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = cls;
    b.textContent = glyph;
    return b;
  }
  const SVG_NS = "http://www.w3.org/2000/svg";
  function iconSvg(d, extraPathAttrs) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 22 22");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    for (const k in extraPathAttrs) path.setAttribute(k, extraPathAttrs[k]);
    svg.append(path);
    return svg;
  }

  // Star for the Merkliste: outline when not saved, filled when saved (the CSS
  // swaps them on "is-saved"), same shape either way.
  const STAR_PATH =
    "M11 2.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8L11 15.9l-5.2 2.7 1-5.8L2.6 8.7l5.8-.8z";
  function starButton() {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "wk-star-btn";
    b.title = "Auf die Merkliste";
    b.append(iconSvg(STAR_PATH, {
      stroke: "currentColor", "stroke-width": "1.6", "stroke-linejoin": "round",
    }));
    return b;
  }

  // Eye-with-slash for "hide from map": same circled button treatment as the star,
  // sitting to its left. The slash overlays a plain eye. On "is-hidden" the CSS
  // shows the slashed eye greyed/filled; otherwise it's a neutral outline.
  const EYE_PATH = "M2 11s3.4-6 9-6 9 6 9 6-3.4 6-9 6-9-6-9-6z";
  const EYE_PUPIL_PATH = "M11 8.2a2.8 2.8 0 100 5.6 2.8 2.8 0 000-5.6z";
  const EYE_SLASH_PATH = "M4 4l14 14";
  function eyeOffButton() {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "wk-hide-btn";
    b.title = "Von der Karte ausblenden";
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 22 22");
    svg.setAttribute("aria-hidden", "true");
    const mk = (d, attrs) => {
      const p = document.createElementNS(SVG_NS, "path");
      p.setAttribute("d", d);
      for (const k in attrs) p.setAttribute(k, attrs[k]);
      return p;
    };
    const stroke = { fill: "none", stroke: "currentColor", "stroke-width": "1.6", "stroke-linecap": "round", "stroke-linejoin": "round" };
    svg.append(mk(EYE_PATH, stroke), mk(EYE_PUPIL_PATH, stroke), mk(EYE_SLASH_PATH, stroke));
    b.append(svg);
    return b;
  }

  // The photo arrows use an SVG chevron, not a "‹" glyph: text arrows sit on the
  // baseline (never optically centred in a circle) and their size varies by font.
  function chevronButton(dir, cls) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = cls;
    const d = dir < 0 ? "M14.5 4.5 8 11l6.5 6.5" : "M7.5 4.5 14 11l-6.5 6.5";
    b.append(iconSvg(d, {
      fill: "none", stroke: "currentColor", "stroke-width": "2.4",
      "stroke-linecap": "round", "stroke-linejoin": "round",
    }));
    return b;
  }
  // Arrow clicks must not bubble: the image is a link to the ad, and the pill
  // itself opens the ad on click.
  function onNav(btn, fn) {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      fn();
    });
  }
  const MAX_DOTS = 10; // beyond this, show "i / n" instead of a dot per photo

  function popupEl(flats) {
    const el = document.createElement("div");
    el.className = "wk-pop";
    let flat = 0; // which listing at this spot
    let shot = 0; // which photo of that listing

    // Listing bar (only when the spot holds several flats).
    if (flats.length > 1) {
      const bar = document.createElement("div");
      bar.className = "wk-listings";
      const prev = navButton("‹", "wk-listings-btn");
      const next = navButton("›", "wk-listings-btn");
      const label = document.createElement("span");
      label.className = "wk-listings-label";
      onNav(prev, () => goFlat(-1));
      onNav(next, () => goFlat(1));
      bar.append(prev, label, next);
      el.append(bar);
      el._label = label;
    }

    const figure = document.createElement("div");
    figure.className = "wk-figure";
    const imgBox = document.createElement("div");
    imgBox.className = "wk-figure-img";
    const back = chevronButton(-1, "wk-shot-btn wk-shot-prev");
    const fwd = chevronButton(1, "wk-shot-btn wk-shot-next");
    const dots = document.createElement("div");
    dots.className = "wk-dots";
    onNav(back, () => goShot(-1));
    onNav(fwd, () => goShot(1));
    figure.append(imgBox, back, fwd, dots);

    const body = document.createElement("div");
    body.className = "wk-pop-body";
    // The text is rewritten on every flat change, so it lives in its own inner div;
    // the icon buttons are separate children of the body (which is their positioning
    // context) so the innerHTML rewrite never destroys them.
    const content = document.createElement("div");
    content.className = "wk-pop-content";
    const star = starButton();
    onNav(star, () => { if (!star.disabled) toggleSaved(flats[flat]); });
    // Eye-off (hide from map): left of the star, always available (no sign-in).
    const eye = eyeOffButton();
    onNav(eye, () => { if (!eye.disabled) toggleHidden(flats[flat]); });
    body.append(content, eye, star);
    el.append(figure, body);

    function renderPhoto() {
      const l = flats[flat];
      const src = l.images[shot];
      const img = src ? '<img src="' + esc(src) + '" alt="">' : "";
      imgBox.innerHTML = l.url
        ? '<a href="' + esc(l.url) + '" target="_blank" rel="noopener">' + img + "</a>"
        : img;

      const n = l.images.length;
      figure.classList.toggle("wk-single-shot", n < 2);
      if (n < 2) dots.innerHTML = "";
      else if (n <= MAX_DOTS) {
        dots.className = "wk-dots";
        dots.innerHTML = "";
        for (let i = 0; i < n; i++) {
          const d = document.createElement("span");
          d.className = "wk-dot-i" + (i === shot ? " is-on" : "");
          dots.append(d);
        }
      } else {
        dots.className = "wk-dots wk-dots-count";
        dots.textContent = shot + 1 + " / " + n;
      }
    }
    function renderFlat() {
      shot = 0;
      content.innerHTML = detailsHtml(flats[flat]);
      if (el._label) el._label.textContent = "Wohnung " + (flat + 1) + " von " + flats.length;
      // The one star button follows whichever flat is on show.
      starTargets = starTargets.filter((t) => t.el !== star);
      trackStar(star, [flats[flat]]);
      // Same for the eye-off button.
      hideTargets = hideTargets.filter((t) => t.el !== eye);
      trackHide(eye, [flats[flat]]);
      // Register this popup's button pair so star/hide lock each other out, then
      // apply the lock for the flat now on show.
      popupButtons = { star, eye, flat: () => flats[flat] };
      syncButtonLocks();
      renderPhoto();
    }
    function goShot(step) {
      const n = flats[flat].images.length;
      if (n < 2) return;
      shot = (shot + step + n) % n;
      renderPhoto();
    }
    function goFlat(step) {
      flat = (flat + step + flats.length) % flats.length;
      renderFlat();
      requestAvail(flats[flat]); // fetch on demand for the flat now shown
    }

    // Called on popupopen (and when paging flats): kick off the on-demand
    // availability fetch for the flat currently shown. NOT called at construction,
    // so we only ever fetch the detail page of an ad the user actually opens.
    el._wkOpen = () => requestAvail(flats[flat]);

    // Let the message handler refresh just the availability chip of the flat on
    // show, without rebuilding the popup (which would reset paging / close it).
    el._wkRefreshAvail = (id) => {
      if (flats[flat].id !== id) return;
      const row = content.querySelector(".wk-pop-availrow");
      if (row) row.innerHTML = availChip(flats[flat]);
    };

    renderFlat();
    return el;
  }

  // ---- Click-to-open popups ---------------------------------------------
  // Leaflet always draws popups above the marker, which clips near the top edge.
  // Instead pick a side (above/below/left/right) that fits the viewport and never
  // covers the pill, preferring the one towards the map centre so it grows inwards.
  // Measure at offset (0,0), then set the offset that moves it to the chosen rect.
  const POPUP_GAP = 10; // px between pill and popup
  const POPUP_PAD = 12; // min px between popup and map edge
  function fitPopup(popup) {
    if (!popup || !popup.isOpen()) return;
    const el = popup.getElement();
    const src = popup._source;
    const pin = src && src.getElement() && src.getElement().querySelector(".wk-price");
    if (!el || !pin) return;

    popup.options.offset = L.point(0, 0);
    popup._updatePosition();

    const box = map.getContainer().getBoundingClientRect();
    const nat = el.getBoundingClientRect(); // natural (offset-free) position
    const m = pin.getBoundingClientRect(); // the pill we must not cover
    const w = nat.width;
    const h = nat.height;
    const cx = (m.left + m.right) / 2;
    const cy = (m.top + m.bottom) / 2;
    const minX = box.left + POPUP_PAD;
    const maxX = box.right - POPUP_PAD - w;
    const minY = box.top + POPUP_PAD;
    const maxY = box.bottom - POPUP_PAD - h;
    const clamp = (v, lo, hi) => (lo > hi ? lo : Math.min(Math.max(v, lo), hi));

    // Candidate rects: fixed on the placement axis, clamped on the other one (so
    // clamping slides the popup along the pill, never on top of it).
    const cands = [
      { x: clamp(cx - w / 2, minX, maxX), y: m.top - POPUP_GAP - h, ok: m.top - POPUP_GAP - h >= minY },
      { x: clamp(cx - w / 2, minX, maxX), y: m.bottom + POPUP_GAP, ok: m.bottom + POPUP_GAP <= maxY },
      { x: m.left - POPUP_GAP - w, y: clamp(cy - h / 2, minY, maxY), ok: m.left - POPUP_GAP - w >= minX },
      { x: m.right + POPUP_GAP, y: clamp(cy - h / 2, minY, maxY), ok: m.right + POPUP_GAP <= maxX },
    ];
    // Prefer the placement whose popup centre lands closest to the map centre.
    const mx = (box.left + box.right) / 2;
    const my = (box.top + box.bottom) / 2;
    const score = (c) => Math.hypot(c.x + w / 2 - mx, c.y + h / 2 - my);
    const fits = cands.filter((c) => c.ok);
    const pick = (fits.length ? fits : [{ x: clamp(cx - w / 2, minX, maxX), y: clamp(m.bottom + POPUP_GAP, minY, maxY) }])
      .sort((a, b) => score(a) - score(b))[0];

    popup.options.offset = L.point(pick.x - nat.left, pick.y - nat.top);
    popup._updatePosition();
  }
  map.on("popupopen", (e) => {
    fitPopup(e.popup);
    // Kick off the on-demand availability fetch now — only for the ad just opened.
    const node = e.popup.getElement();
    const pop = node && node.querySelector(".wk-pop");
    if (pop && pop._wkOpen) pop._wkOpen();
    // The image loads late and grows the popup upwards — re-fit when it arrives.
    if (node) {
      node.querySelectorAll("img").forEach((img) => {
        if (!img.complete) img.addEventListener("load", () => fitPopup(e.popup), { once: true });
      });
    }
  });
  map.on("move zoom", () => {
    const p = map._popup;
    if (p) fitPopup(p);
  });

  function attachClickPopup(marker) {
    // Listen on the pill element, not the Leaflet marker (whose hit-target is the
    // whole container) — so the popup toggles only when the pill itself is clicked.
    // Clicking the pill toggles the popup; clicking the map elsewhere closes it
    // (Leaflet's closePopupOnClick). The ad opens via the popup image, not the pill.
    marker.on("add", () => {
      const root = marker.getElement();
      const el = root && root.querySelector(".wk-price");
      if (!el) return;
      el.style.cursor = "pointer";
      el.addEventListener("click", (e) => {
        e.stopPropagation(); // don't let the map treat it as a "click elsewhere"
        marker.togglePopup();
      });
    });
  }

  // ---- Markers ----------------------------------------------------------
  function pill(html) {
    // className "wk-pin": the container is pointer-events:none (see CSS) so only
    // the visible pill/dot inside it catches the mouse — no offset ghost hit-area.
    return L.divIcon({ className: "wk-pin", html, iconSize: null, iconAnchor: [0, 0] });
  }

  // A pill on the Merkliste carries "is-saved" and the CSS recolours it (gold);
  // no icon — a star glyph crowds a pill this small.
  function pricePillMarker(l) {
    const m = L.marker([l.lat, l.lng], {
      icon: pill('<div class="wk-price">' + esc(l.priceLabel) + "</div>"),
      riseOnHover: true,
    });
    m.bindPopup(popupEl([l]), { minWidth: 320, maxWidth: 680, autoPan: false });
    attachClickPopup(m);
    m.on("add", () => {
      const el = m.getElement() && m.getElement().querySelector(".wk-price");
      if (el) {
        trackStar(el, [l]);
        trackHide(el, [l]);
      }
    });
    return m;
  }

  function groupMarker(unit) {
    const cheapest = unit.flats[0];
    const html =
      '<div class="wk-price wk-group">' +
      esc(cheapest.priceLabel) +
      '<span class="wk-more">+' + (unit.n - 1) + "</span>" +
      "</div>";
    const m = L.marker([unit.lat, unit.lng], { icon: pill(html), riseOnHover: true });
    m.bindPopup(popupEl(unit.flats), { minWidth: 320, maxWidth: 680, autoPan: false });
    attachClickPopup(m);
    // A group pill stars if any flat at that spot is on the Merkliste, and reads
    // as hidden if any of them is hidden (while "show hidden" reveals it).
    m.on("add", () => {
      const el = m.getElement() && m.getElement().querySelector(".wk-price");
      if (el) {
        trackStar(el, unit.flats);
        trackHide(el, unit.flats);
      }
    });
    return m;
  }

  function dotMarker(lat, lng) {
    const m = L.marker([lat, lng], { icon: pill('<div class="wk-dot"></div>'), pane: "wkDots" });
    m.on("click", () => map.setZoomAround([lat, lng], Math.min(map.getZoom() + 2, 19)));
    return m;
  }

  // ---- Build "units" (merge only genuinely-coincident flats) ------------
  let units = [];
  function buildUnits(flats) {
    const buckets = new Map();
    for (const l of flats) {
      const p = map.project([l.lat, l.lng], COINCIDE_ZOOM);
      const k = Math.round(p.x / COINCIDE_PX) + "_" + Math.round(p.y / COINCIDE_PX);
      let b = buckets.get(k);
      if (!b) buckets.set(k, (b = []));
      b.push(l);
    }
    const out = [];
    for (const b of buckets.values()) {
      b.sort(priceAsc);
      out.push({ lat: b[0].lat, lng: b[0].lng, flats: b, n: b.length, priceNum: b[0].priceNum });
    }
    out.sort((a, b) => {
      if (a.n > 1 && b.n <= 1) return -1;
      if (b.n > 1 && a.n <= 1) return 1;
      if (a.n > 1 && b.n > 1) return b.n - a.n;
      return priceAsc(a, b);
    });
    return out;
  }

  // ---- Reconciled render of pills + dots --------------------------------
  const shown = new Map(); // key -> marker
  let didFit = false;
  let lastLoadId = null;
  let lastListings = []; // last listings received, for re-render on hide toggle

  function updateVisible() {
    if (!units.length) {
      layer.clearLayers();
      shown.clear();
      return;
    }
    const zoom = map.getZoom();
    const bounds = map.getBounds().pad(0.15);

    const desired = new Map(); // key -> () => marker
    const leftovers = [];

    const marker = (u) => () => (u.n > 1 ? groupMarker(u) : pricePillMarker(u.flats[0]));
    // Greedy placement: reject a candidate whose centre lands in the PILL_W x PILL_H
    // box of one already placed.
    const placed = [];
    const collides = (p) =>
      placed.some((q) => Math.abs(p.x - q.x) < PILL_W && Math.abs(p.y - q.y) < PILL_H);
    // Reconciliation key: pill position rounded to a PILL_W x PILL_H grid. Absolute
    // (not viewport-relative), so it survives a pan; non-colliding pills never share
    // a cell, so keys are unique.
    const cellKey = (p) => Math.round(p.x / PILL_W) + "_" + Math.round(p.y / PILL_H);

    // Pinned units first: always a pill, never demoted by the cap or a collision.
    // Only hidden units (when the "hidden" switch is on), so each stays reachable
    // to unhide — a hidden flat demoted to a dot couldn't be unhidden. Starred
    // flats are NOT pinned: with the view toggles they no longer need to override
    // the slider cap. Keyed by listing id (survives a zoom).
    for (const u of units) {
      if (!(view.hidden && u.flats.some(isHidden))) continue;
      if (!bounds.contains([u.lat, u.lng])) continue;
      const p = map.project([u.lat, u.lng], zoom);
      placed.push(p);
      const key = cellKey(p);
      // If already shown as a normal pill, keep that key so toggling leaves the
      // marker (and its open popup) alone.
      desired.set(shown.has("p:" + key) ? "p:" + key : "s:" + u.flats[0].id, marker(u));
    }

    // The rest compete for the maxPills budget, nearest the view centre first so
    // pills cluster where you're looking. Ties fall back to `units` order (groups
    // first, then cheapest).
    const c = map.project(map.getCenter(), zoom);
    const candidates = [];
    units.forEach((u, i) => {
      if (view.hidden && u.flats.some(isHidden)) return; // pinned above
      if (!bounds.contains([u.lat, u.lng])) return;
      const p = map.project([u.lat, u.lng], zoom);
      candidates.push({ u, p, i, d: Math.round(c.distanceTo(p) / PILL_W) });
    });
    candidates.sort((a, b) => a.d - b.d || a.i - b.i);

    // First pass: spaced-out pills, no overlap.
    let pills = 0;
    const rejected = [];
    for (const cand of candidates) {
      if (pills >= maxPills) {
        leftovers.push(cand);
      } else if (collides(cand.p)) {
        rejected.push(cand);
      } else {
        placed.push(cand.p);
        pills++;
        desired.set("p:" + cellKey(cand.p), marker(cand.u));
      }
    }

    // Second pass: more pills asked for than fit collision-free, so honour the count
    // and let them overlap. Keyed by unit id — cell keys are unique only when spaced.
    for (const cand of rejected) {
      if (pills >= maxPills) {
        leftovers.push(cand);
        continue;
      }
      pills++;
      desired.set("o:" + cand.u.flats[0].id, marker(cand.u));
    }

    // Density dots for everything that didn't get a pill, one per coarse cell.
    // They render below the pills (wkDots pane), so any dot under a pill is hidden.
    const dotCells = new Set();
    for (const { u, p } of leftovers) {
      const dcell = Math.round(p.x / DOT_CELL) + "_" + Math.round(p.y / DOT_CELL);
      if (dotCells.has(dcell)) continue;
      dotCells.add(dcell);
      desired.set("d:" + dcell, () => dotMarker(u.lat, u.lng));
    }

    // Reconcile: keep markers whose key persists (so an open popup survives a pan).
    for (const [k, m] of shown) {
      if (!desired.has(k)) {
        layer.removeLayer(m);
        shown.delete(k);
      }
    }
    for (const [k, make] of desired) {
      if (shown.has(k)) continue;
      const m = make();
      shown.set(k, m);
      layer.addLayer(m);
    }
  }

  function render(listings, loadId) {
    // A new load id = fresh search: allow the view to auto-fit again so it
    // recenters on the new results.
    if (loadId !== lastLoadId) {
      lastLoadId = loadId;
      didFit = false;
    }
    lastListings = listings || [];
    // A flat is drawn only if its category's switch is on.
    const flats = lastListings.filter((l) => view[category(l)]).slice().sort(priceAsc);
    units = buildUnits(flats);

    layer.clearLayers();
    shown.clear();

    if (!units.length) {
      empty.style.display = "flex";
      return;
    }
    empty.style.display = "none";

    if (!didFit) {
      const pts = flats.map((l) => [l.lat, l.lng]);
      if (pts.length === 1) map.setView(pts[0], 15);
      else map.fitBounds(pts, { padding: [40, 40], maxZoom: 16 });
      didFit = true;
    }
    updateVisible();
  }

  map.on("zoomend", updateVisible);
  map.on("moveend", updateVisible);

  window.addEventListener("message", (e) => {
    const d = e.data;
    if (!d) return;
    if (d.type === "willkarte:listings") render(d.listings, d.loadId);
    if (d.type === "willkarte:detail") {
      availById.set(String(d.id), d.available || null);
      // If the open popup shows this flat, refresh its chip in place.
      const p = map._popup;
      const el = p && p.getElement() && p.getElement().querySelector(".wk-pop");
      console.log("[willkarte] iframe got detail", d.id, "available=", d.available, "refresh?", !!(el && el._wkRefreshAvail));
      if (el && el._wkRefreshAvail) el._wkRefreshAvail(String(d.id));
    }
    if (d.type === "willkarte:saved") {
      savedIds = new Set((d.ids || []).map(String));
      canSave = !!d.canSave; // signed out: no star button at all
      document.body.classList.toggle("wk-can-save", canSave);
      paintStars();
      // Starring moves a flat between the "untouched" and "starred" categories, so
      // whether it's drawn can change — rebuild units to re-apply the filter.
      render(lastListings, lastLoadId);
    }
    if (d.type === "willkarte:hidden") {
      hiddenIds = new Set((d.ids || []).map(String));
      paintHidden();
      render(lastListings, lastLoadId); // apply the (un)hides to what's drawn
    }
    if (d.type === "willkarte:view") {
      view = Object.assign({ starred: true, hidden: false, untouched: true }, d.view || {});
      render(lastListings, lastLoadId);
    }
    if (d.type === "willkarte:maxpills" && d.n >= 0) {
      maxPills = d.n;
      updateVisible();
    }
    if (d.type === "willkarte:show")
      setTimeout(() => {
        map.invalidateSize();
        updateVisible();
      }, 60);
  });

  if (window.parent) window.parent.postMessage({ type: "willkarte:ready" }, "*");
})();
