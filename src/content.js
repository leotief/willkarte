// willkarte — content script
// Runs on willhaben real estate search pages. Adds a floating "Karte" button
// that opens a full-screen map of the current search results. The map itself is
// rendered in an extension-owned iframe (map.html) so it isn't blocked by
// willhaben's content-security policy.
//
// Listing data is read from willhaben's own server-rendered JSON (the
// __NEXT_DATA__ script tag), fetched page by page from the current search URL.

(function () {
  "use strict";

  if (window.__willkarteLoaded) return;
  window.__willkarteLoaded = true;

  const api = typeof browser !== "undefined" ? browser : chrome;

  // Searches can have thousands of hits; cap for politeness/performance.
  const MAX_LISTINGS = 1000;
  const ROWS_PER_PAGE = 100; // requested page size (willhaben may cap it lower)
  const MAX_PAGES = 40; // hard safety bound on number of requests
  const DEFAULT_PILLS = 50; // price pills shown at once (slider in the top bar)
  const PAGE_DELAY_MS = 200; // pause between requests

  // Load state. A fresh load starts on each map open; `loadGen` supersedes any
  // load still running if you re-open before it finished.
  let current = []; // listings collected so far
  let byId = new Map(); // de-dupes across pages
  let total = null; // full hit count for the current filters
  let loadGen = 0;
  // "Verfügbar ab" range filter — month granularity, "yyyy-mm" strings (or null).
  // `availFilterFrom` = earliest acceptable month, `availFilterTo` = latest. Either or
  // both may be set. Set from the "Filter" dropdown; drives the detail-page sweep.
  let availFilterFrom = null;
  let availFilterTo = null;
  function availFilterOn() {
    return !!availFilterFrom || !!availFilterTo;
  }

  // ---- Parsing willhaben's embedded data --------------------------------
  function rootFrom(doc) {
    const el = doc.getElementById("__NEXT_DATA__");
    try {
      return el ? JSON.parse(el.textContent) : null;
    } catch (e) {
      return null;
    }
  }

  function searchResultOf(root) {
    return root?.props?.pageProps?.searchResult || null;
  }

  function totalOf(sr) {
    return sr?.rowsFound || sr?.rowsRequested || sr?.rowsReturned || null;
  }


  // Short marker label, e.g. 679 -> "€679", 320000 -> "€320k", 1.25M -> "€1,3M".
  function compactPrice(num, fallback) {
    if (!isFinite(num)) return fallback || "?";
    if (num >= 1e6) return "€" + (num / 1e6).toFixed(1).replace(".", ",") + "M";
    if (num >= 1e4) return "€" + Math.round(num / 1e3) + "k";
    return "€" + Math.round(num);
  }

  // Turn willhaben's advert list into the compact shape the map needs.
  function parseListings(root) {
    const raw = searchResultOf(root)?.advertSummaryList?.advertSummary;
    if (!Array.isArray(raw)) return [];

    return raw
      .map((ad) => {
        // willhaben stores fields as a [{name, values}] list — flatten it.
        const a = {};
        const attrs = ad?.attributes?.attribute;
        if (Array.isArray(attrs)) for (const at of attrs) a[at.name] = at.values && at.values[0];

        const [lat, lng] = (a.COORDINATES || "").split(",").map(Number);
        if (!isFinite(lat) || !isFinite(lng)) return null; // no map without coords

        const priceNum = parseFloat(a.PRICE);
        return {
          id: String(ad.id || a.ADID || a.AD_UUID),
          lat,
          lng,
          priceNum: isFinite(priceNum) ? priceNum : null,
          priceDisplay: a.PRICE_FOR_DISPLAY || (a.PRICE ? "€ " + a.PRICE : "—"),
          priceLabel: compactPrice(priceNum, a.PRICE_FOR_DISPLAY),
          title: a.HEADING || ad.description || "",
          address: [a.ADDRESS, a.POSTCODE, a.LOCATION].filter(Boolean).join(", "),
          size: a["ESTATE_SIZE/LIVING_AREA"] || a.ESTATE_SIZE || null,
          rooms: a.NUMBER_OF_ROOMS || null,
          // Floor (Stockwerk). Missing ⇒ null ⇒ the popup omits it. (There's no
          // "verfügbar ab" field in the search-list JSON — only on the ad detail page.)
          floor: a.FLOOR || null,
          // PUBLISHED = ms timestamp of when the ad was last published/bumped —
          // willhaben updates it on edit/bump, so it matches the detail page's
          // "Zuletzt geändert". In the search JSON on every listing (no fetch).
          // Feeds the "Veröffentlicht / geändert" filter.
          published: (() => {
            const t = parseInt(a.PUBLISHED, 10);
            return isFinite(t) ? t : null;
          })(),
          // ALL_IMAGE_URLS is one ";"-separated string of every photo of the ad;
          // MMO is just the primary one. Fall back to MMO if it's missing.
          images: (a.ALL_IMAGE_URLS ? a.ALL_IMAGE_URLS.split(";") : a.MMO ? [a.MMO] : [])
            .map((p) => p.trim())
            .filter(Boolean)
            .map((p) => "https://cache.willhaben.at/mmo/" + p),
          url: a.SEO_URL ? "https://www.willhaben.at/iad/" + a.SEO_URL : ad.selfLink || null,
        };
      })
      .filter(Boolean);
  }

  // ---- Merkliste (willhaben's own "Anzeige merken") ---------------------
  // Saved state isn't in the search JSON; it lives in willhaben's BFF at /webapi.
  // We call it with the session cookie (this script runs on willhaben.at):
  //   GET    /iad/userfolders/all/{loginId}  -> { adIds: [{ adId }, ...] }
  //   GET    /iad/userfolders/{loginId}      -> { advertFolders: [{ id, name }] }
  //   POST   /iad/userfolders/save/{loginId}/{folderId}/{adId}
  //   DELETE /iad/userfolders/savedAd/{loginId}/{adId}
  // Headers: X-WH-Client on every call, and a CSRF token (the x-bbx-csrf-token
  // cookie echoed back as a header) on non-GETs — without them the BFF rejects.
  // `loginId` is in __NEXT_DATA__ when signed in; absent ⇒ no stars.
  // URL must be absolute: a Firefox content-script fetch has no page origin to
  // resolve "/webapi/…" against.
  const API = "https://www.willhaben.at/webapi";
  const CSRF = "x-bbx-csrf-token";
  const loginId = (() => {
    const p = rootFrom(document)?.props?.profileData;
    return p && p.loginId != null ? String(p.loginId) : null;
  })();
  let folderId = null; // the Merkliste to save into (willhaben's default: the first)
  let saved = new Set(); // ad ids currently on the Merkliste

  function cookie(name) {
    const hit = document.cookie
      .split("; ")
      .find((c) => c.slice(0, name.length + 1) === name + "=");
    return hit ? decodeURIComponent(hit.slice(name.length + 1)) : null;
  }
  async function wh(path, opts = {}) {
    const method = opts.method || "GET";
    const token = method === "GET" ? null : cookie(CSRF);
    const res = await fetch(API + path, {
      credentials: "include",
      ...opts,
      headers: {
        Accept: "application/json",
        "Cache-Control": "no-cache",
        "X-WH-Client": "api@willhaben.at;responsive_web;server;1.0.0;",
        ...(token ? { [CSRF]: token } : {}),
        ...opts.headers,
      },
    });
    if (!res.ok) throw new Error(method + " " + path + " → HTTP " + res.status);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }
  function sendSaved() {
    post({ type: "willkarte:saved", ids: [...saved], canSave: !!loginId });
    if (typeof refreshViewMenu === "function") refreshViewMenu();
  }
  async function loadSaved() {
    if (!loginId) return;
    try {
      const data = await wh("/iad/userfolders/all/" + loginId);
      saved = new Set((data?.adIds || []).map((a) => String(a.adId)));
    } catch (e) {
      console.log("[willkarte] Merkliste not readable:", e);
    }
    sendSaved();
  }
  async function folder() {
    if (folderId == null) {
      const data = await wh("/iad/userfolders/" + loginId);
      const f = (data?.advertFolders || [])[0];
      if (!f || f.id == null) throw new Error("no Merkliste folder");
      folderId = f.id;
    }
    return folderId;
  }
  // The map updates its star optimistically; we always answer with the real state,
  // so a failed call snaps the star back.
  async function setSaved(id, want) {
    if (!loginId) return;
    try {
      if (want) {
        await wh("/iad/userfolders/save/" + loginId + "/" + (await folder()) + "/" + id, {
          method: "POST",
        });
        saved.add(String(id));
      } else {
        await wh("/iad/userfolders/savedAd/" + loginId + "/" + id, { method: "DELETE" });
        saved.delete(String(id));
      }
    } catch (e) {
      console.log("[willkarte] Merkliste update failed:", e);
    }
    sendSaved();
  }

  // ---- Ausblenden (our own "hide from map") -----------------------------
  // Not a willhaben feature — purely ours. A set of ad ids stored in the
  // extension's own storage.local (survives sessions, reloads, and navigations),
  // global across all searches. Hidden listings are dropped from the map unless
  // the "show hidden" toggle is on. No sign-in needed.
  const HIDDEN_KEY = "willkarte:hidden";
  let hidden = new Set(); // ad ids the user has hidden

  // "Neue seit letztem Besuch": the baseline is the time of the PREVIOUS page load.
  // Captured once when this content script inits (i.e. per willhaben page load /
  // reload) — reopening the map on the same page keeps the same baseline; only a
  // reload advances it. `prevVisitTs` (ms) is what the filter compares against;
  // `now` is written back so the *next* reload sees what's new since this one.
  const VISIT_KEY = "willkarte:lastVisit";
  let prevVisitTs = 0; // 0 until read; means "everything is new" on a first-ever visit
  (async () => {
    try {
      const res = await storageGet(VISIT_KEY);
      const t = res && res[VISIT_KEY];
      prevVisitTs = typeof t === "number" && isFinite(t) ? t : 0;
    } catch (e) {
      prevVisitTs = 0;
    }
    await storageSet({ [VISIT_KEY]: Date.now() });
    // If the filter was already toggled on before this resolved, re-send it.
    if (typeof sendPubFilter === "function") sendPubFilter();
  })();

  // storage.local is promise-based in Firefox, callback-based in Chrome MV3.
  // Promisify so the same code works in both.
  function storageGet(key) {
    return new Promise((resolve) => {
      try {
        const r = api.storage.local.get(key);
        if (r && typeof r.then === "function") r.then(resolve, () => resolve({}));
        else api.storage.local.get(key, (res) => resolve(res || {}));
      } catch (e) {
        resolve({});
      }
    });
  }
  function storageSet(obj) {
    return new Promise((resolve) => {
      try {
        const r = api.storage.local.set(obj);
        if (r && typeof r.then === "function") r.then(() => resolve(true), () => resolve(false));
        else api.storage.local.set(obj, () => resolve(true));
      } catch (e) {
        resolve(false);
      }
    });
  }

  function sendHidden() {
    post({ type: "willkarte:hidden", ids: [...hidden] });
    if (typeof refreshViewMenu === "function") refreshViewMenu();
  }
  async function loadHidden() {
    try {
      const res = await storageGet(HIDDEN_KEY);
      const arr = res && res[HIDDEN_KEY];
      hidden = new Set(Array.isArray(arr) ? arr.map(String) : []);
    } catch (e) {
      console.log("[willkarte] hidden list not readable:", e);
    }
    sendHidden();
  }
  // The map toggles optimistically; we persist and always answer with the true
  // set, so a failed write snaps it back.
  async function setHidden(id, want) {
    const key = String(id);
    if (want) hidden.add(key);
    else hidden.delete(key);
    await storageSet({ [HIDDEN_KEY]: [...hidden] });
    sendHidden();
  }
  // Unhide everything at once (the "Ausblenden aufheben" action).
  async function unhideAll() {
    hidden = new Set();
    await storageSet({ [HIDDEN_KEY]: [] });
    sendHidden();
  }

  // ---- UI: floating toggle + full-screen overlay ------------------------
  const toggle = document.createElement("button");
  toggle.id = "willkarte-toggle";
  toggle.textContent = "🗺 Karte";

  // One row of the "Ansicht" menu: a label + an on/off pill switch. `key` matches
  // a category in the view state; the pill's on/off is driven later by JS.
  function viewToggleHtml(key, label) {
    return (
      '<button type="button" role="menuitemcheckbox" class="willkarte-view-item" data-view="' + key + '">' +
      '<span class="willkarte-view-label">' + label + "</span>" +
      '<span class="willkarte-switch" aria-hidden="true"><span class="willkarte-knob"></span></span>' +
      "</button>"
    );
  }

  // The multi-select floor filter: a compact row of toggle chips. `key` is the
  // filter key sent to the map; on/off is driven later by JS (is-on class).
  const FLOOR_CHIPS = [
    { key: "eg", label: "EG" },
    { key: "1", label: "1" },
    { key: "2", label: "2" },
    { key: "3", label: "3" },
    { key: "4plus", label: "4+" },
    { key: "dg", label: "DG" },
  ];
  function floorChipsHtml() {
    return FLOOR_CHIPS.map(
      (c) =>
        '<button type="button" role="menuitemcheckbox" aria-checked="false" ' +
        'class="willkarte-floor-chip" data-floor="' + c.key + '">' + c.label + "</button>"
    ).join("");
  }

  const overlay = document.createElement("div");
  overlay.id = "willkarte-overlay";
  overlay.innerHTML =
    '<div id="willkarte-bar">' +
    '<span id="willkarte-count">willkarte</span>' +
    '<div id="willkarte-bar-right">' +
    // --- "Filter" dropdown: extra filters willhaben can't do natively. ---
    '<div id="willkarte-filter">' +
    '<button type="button" id="willkarte-filter-btn" aria-haspopup="true" ' +
    'aria-expanded="false" title="Zusätzliche Filter">Zusätzliche Filter <span id="willkarte-filter-caret">▾</span></button>' +
    '<div id="willkarte-filter-menu" role="menu" hidden>' +
    '<div class="willkarte-menu-head">Verfügbar ab</div>' +
    '<label id="willkarte-avail" title="Monat, in dem die Wohnung verfügbar sein soll (verfügbar ab). ' +
    '„frühestens“ = nicht vor diesem Monat, „spätestens“ = nicht nach diesem Monat. Beide optional. ' +
    'Anzeigen ohne Datum bleiben sichtbar; „ab sofort“ zählt als der aktuelle Monat. ' +
    'Aktiviert lädt willkarte die „verfügbar ab“-Daten aller Anzeigen nach.">' +
    // Month+year dropdowns (not <input type=date>): the native picker showed MM/DD/YYYY
    // (its format follows the browser UI locale and can't be forced) and day precision
    // isn't needed here. Options are filled in JS (they depend on the current month).
    '<span class="willkarte-avail-row">' +
    '<span class="willkarte-avail-lbl">frühestens</span>' +
    '<select id="willkarte-avail-from" class="willkarte-avail-sel"></select>' +
    "</span>" +
    '<span class="willkarte-avail-row">' +
    '<span class="willkarte-avail-lbl">spätestens</span>' +
    '<select id="willkarte-avail-date" class="willkarte-avail-sel"></select>' +
    "</span>" +
    '<span id="willkarte-avail-status" class="willkarte-avail-status" hidden></span>' +
    "</label>" +
    // --- Section: publish / last-changed date (PUBLISHED, in the search JSON) ---
    // One slider, fixed non-linear stops. "Seit letztem Besuch" is the first stop
    // after "Alle" — so the two publish-date filters are one mutually-exclusive choice.
    '<div class="willkarte-menu-head">Veröffentlicht / geändert</div>' +
    '<label id="willkarte-pub" title="Nur Anzeigen zeigen, die in diesem Zeitraum veröffentlicht oder aktualisiert wurden. „Seit letztem Besuch“ = seit deinem vorigen Besuch dieser Seite.">' +
    '<span class="willkarte-pub-row"><span>Zeitraum</span>' +
    '<output id="willkarte-pub-val">Alle</output></span>' +
    '<input type="range" id="willkarte-pub-range" min="0" max="7" step="1" value="0">' +
    "</label>" +
    // --- Section: floor (Stockwerk), multi-select chips ---
    '<div class="willkarte-menu-head">Stockwerk</div>' +
    '<div id="willkarte-floor" title="Nur ausgewählte Stockwerke zeigen. Mehrfachauswahl möglich. ' +
    'Anzeigen ohne Stockwerk-Angabe bleiben sichtbar.">' +
    floorChipsHtml() +
    "</div>" +
    "</div>" +
    "</div>" +
    '<div id="willkarte-view">' +
    '<button type="button" id="willkarte-view-btn" aria-haspopup="true" ' +
    'aria-expanded="false" title="Ansicht & Karte einstellen">Ansicht <span id="willkarte-view-caret">▾</span></button>' +
    '<div id="willkarte-view-menu" role="menu" hidden>' +
    // --- Section: what to show ---
    '<div class="willkarte-menu-head">Anzeigen</div>' +
    viewToggleHtml("untouched", "Ungesehene") +
    viewToggleHtml("starred", "Vorgemerkte") +
    viewToggleHtml("hidden", "Ausgeblendete") +
    '<button type="button" role="menuitem" class="willkarte-view-item willkarte-view-action" id="willkarte-unhide-all" ' +
    'title="Ausgeblendet-Liste leeren – alle wieder sichtbar">↩ Alle einblenden</button>' +
    // --- Section: map density ---
    '<div class="willkarte-menu-head">Karte</div>' +
    '<label id="willkarte-pills" title="Wie viele Anzeigen gleichzeitig auf der Karte. ' +
    'Über das, was überschneidungsfrei Platz hat, werden die Anzeigen übereinander gezeichnet.">' +
    '<span class="willkarte-pills-row"><span>Sichtbare Anzeigen</span>' +
    '<output id="willkarte-pills-val">' + DEFAULT_PILLS + "</output></span>" +
    '<input type="range" id="willkarte-pills-range" min="0" max="' + DEFAULT_PILLS +
    '" step="1" value="' + DEFAULT_PILLS + '">' +
    "</label>" +
    "</div>" +
    "</div>" +
    '<button type="button" id="willkarte-close" title="Karte schließen">✕ Karte schließen</button>' +
    "</div>" +
    "</div>";

  const iframe = document.createElement("iframe");
  iframe.id = "willkarte-iframe";
  iframe.src = api.runtime.getURL("map.html");
  overlay.appendChild(iframe);

  document.body.append(toggle, overlay);

  function openMap() {
    overlay.classList.add("willkarte-open");
    toggle.style.display = "none";
    // A tagged history entry so the back button closes the map instead of
    // navigating willhaben away.
    if (!(history.state && history.state.willkarte)) {
      history.pushState({ willkarte: true }, "");
    }
    startLoading(); // (re)load the current search each time the map opens
    post({ type: "willkarte:show" }); // the map was sized while hidden — recalc
  }
  function hideMap() {
    overlay.classList.remove("willkarte-open");
    toggle.style.display = "";
  }
  // User-initiated close (button/Escape): pop our history entry, which fires
  // popstate → hideMap. If it's not on top (shouldn't happen), hide directly.
  function closeMap() {
    if (history.state && history.state.willkarte) history.back();
    else hideMap();
  }

  // Pill count lives here (not the map) so the slider can sit in the top bar; the
  // map is told on every change and on ready. Max = loaded count ("show them all").
  const pillRange = overlay.querySelector("#willkarte-pills-range");
  const pillVal = overlay.querySelector("#willkarte-pills-val");
  function sendMaxPills() {
    post({ type: "willkarte:maxpills", n: Number(pillRange.value) });
  }
  // As listings stream in the ceiling is the result count, and until the user
  // touches the slider the value derives from it — so 3 hits show 3, not "50 of 3".
  let pillsTouched = false;
  function setPillMax(loaded) {
    const max = Math.max(Number(pillRange.min), loaded);
    const value = pillsTouched
      ? Math.min(Number(pillRange.value), max) // keep the user's choice, but in range
      : Math.min(DEFAULT_PILLS, max);
    if (Number(pillRange.max) === max && Number(pillRange.value) === value) return;
    pillRange.max = String(max);
    pillRange.value = String(value);
    pillVal.textContent = pillRange.value;
    sendMaxPills();
  }
  pillRange.addEventListener("input", () => {
    pillsTouched = true;
    pillVal.textContent = pillRange.value;
    sendMaxPills();
  });

  // "Ansicht" (view) dropdown: three independent on/off switches, one per listing
  // category, plus an "unhide all" action. The map does the actual filtering; we
  // just send which categories are shown. A listing shows if its category is on.
  //   starred   — Merkliste flats                    (default ON)
  //   hidden    — ausgeblendete flats (shown dimmed)  (default OFF)
  //   untouched — neither starred nor hidden          (default ON)
  const viewWrap = overlay.querySelector("#willkarte-view");
  const viewBtn = overlay.querySelector("#willkarte-view-btn");
  const viewMenu = overlay.querySelector("#willkarte-view-menu");
  const unhideAllBtn = overlay.querySelector("#willkarte-unhide-all");
  const viewItems = overlay.querySelectorAll(".willkarte-view-item[data-view]");
  const view = { starred: true, hidden: false, untouched: true };

  function sendView() {
    post({ type: "willkarte:view", view: { ...view } });
  }
  function refreshViewMenu() {
    for (const it of viewItems) {
      const on = !!view[it.dataset.view];
      it.setAttribute("aria-checked", String(on));
      it.classList.toggle("is-on", on);
    }
    unhideAllBtn.hidden = !hidden.size; // gone entirely when nothing is hidden
    // The "Ansicht" button reads as filtered whenever the view isn't the default
    // (starred+untouched shown, hidden not).
    const filtered = !view.starred || view.hidden || !view.untouched;
    viewBtn.classList.toggle("is-filtered", filtered);
  }

  let menuOpen = false;
  function openMenu() {
    closeFilterMenu(); // only one dropdown open at a time
    menuOpen = true;
    viewMenu.hidden = false;
    viewBtn.setAttribute("aria-expanded", "true");
  }
  function closeMenu() {
    menuOpen = false;
    viewMenu.hidden = true;
    viewBtn.setAttribute("aria-expanded", "false");
  }
  viewBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    menuOpen ? closeMenu() : openMenu();
  });
  for (const it of viewItems) {
    it.addEventListener("click", () => {
      const k = it.dataset.view;
      view[k] = !view[k]; // independent flip; menu stays open for more toggling
      refreshViewMenu();
      sendView();
    });
  }
  unhideAllBtn.addEventListener("click", () => {
    if (unhideAllBtn.disabled) return;
    unhideAll();
    closeMenu();
  });
  refreshViewMenu();

  // ---- "Filter" dropdown ------------------------------------------------
  // Extra filters willhaben can't do itself. Currently: a latest availability
  // date ("verfügbar bis"). The date lives only on each ad's detail page, so the
  // map can only filter an ad once its date is known. In the DEFAULT map dates
  // are fetched lazily (on popup open) — but the moment a date filter is set we
  // fetch the detail page of EVERY loaded ad, throttled, so the whole map obeys
  // it. Clearing the filter stops the sweep. The map keeps unknown/"ab sofort"
  // ads shown, so it applies the cutoff itself as dates stream in.
  const filterWrap = overlay.querySelector("#willkarte-filter");
  const filterBtn = overlay.querySelector("#willkarte-filter-btn");
  const filterMenu = overlay.querySelector("#willkarte-filter-menu");
  const availFrom = overlay.querySelector("#willkarte-avail-from"); // earliest month
  const availDate = overlay.querySelector("#willkarte-avail-date"); // latest month ("to")
  const availStatus = overlay.querySelector("#willkarte-avail-status");
  // Fill both month dropdowns: a blank "—" (off) then the current month + 23 ahead.
  // Option value is "yyyy-mm"; the label is a German "Monat JJJJ".
  (function fillMonthSelects() {
    const MONTHS = ["Jänner", "Februar", "März", "April", "Mai", "Juni",
      "Juli", "August", "September", "Oktober", "November", "Dezember"];
    const now = new Date();
    let html = '<option value="">—</option>';
    for (let i = 0; i < 24; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
      const val = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
      html += '<option value="' + val + '">' + MONTHS[d.getMonth()] + " " + d.getFullYear() + "</option>";
    }
    availFrom.innerHTML = html;
    availDate.innerHTML = html;
  })();

  let filterMenuOpen = false;
  function openFilterMenu() {
    closeMenu(); // only one dropdown open at a time
    filterMenuOpen = true;
    filterMenu.hidden = false;
    filterBtn.setAttribute("aria-expanded", "true");
  }
  function closeFilterMenu() {
    filterMenuOpen = false;
    filterMenu.hidden = true;
    filterBtn.setAttribute("aria-expanded", "false");
  }
  filterBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    filterMenuOpen ? closeFilterMenu() : openFilterMenu();
  });

  // ---- One shared close mechanism for BOTH dropdowns --------------------
  // Anything that isn't inside the currently-open menu (its own wrapper) closes it:
  //   • a click anywhere else in the page / overlay (bubbles to document)
  //   • Escape
  //   • a click inside the map iframe — which does NOT reach this document (the
  //     iframe swallows it), so we also listen for the window `blur` that fires when
  //     focus moves into the iframe.
  function closeAllMenus() {
    if (menuOpen) closeMenu();
    if (filterMenuOpen) closeFilterMenu();
  }
  document.addEventListener("click", (e) => {
    if (menuOpen && !viewWrap.contains(e.target)) closeMenu();
    if (filterMenuOpen && !filterWrap.contains(e.target)) closeFilterMenu();
  });
  window.addEventListener("blur", () => {
    // Focus left the top document — typically because a click landed in the map
    // iframe. Close whatever menu is open.
    if (menuOpen || filterMenuOpen) closeAllMenus();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && (menuOpen || filterMenuOpen)) {
      // This and the map's own Escape handler both live on `document`; stopImmediate
      // keeps Escape from also closing the whole map when only a menu is open.
      e.stopImmediatePropagation();
      closeAllMenus();
    }
  });

  // Throttled sweep: fetch every loaded ad's detail page so its date is known.
  // `sweepGen` cancels an in-flight sweep when the filter clears or a new load
  // starts; a sweep is (re)kicked whenever the filter is active and new listings
  // have streamed in.
  const SWEEP_CONCURRENCY = 5;
  let sweepGen = 0;
  let sweepingGen = -1; // which gen's sweep loop is currently running (-1 = none)
  function updateAvailStatus() {
    if (!availFilterOn()) {
      availStatus.hidden = true;
      return;
    }
    const done = current.filter((l) => detailCache.has(l.id) && detailCache.get(l.id) !== "pending").length;
    availStatus.hidden = false;
    availStatus.textContent =
      done >= current.length
        ? "Alle " + current.length + " Daten geladen"
        : "Lade Daten… " + done + " / " + current.length;
  }
  // Tell the map whether a date sweep is in progress. While active the map holds
  // its markers still (so popups don't get destroyed mid-open); on inactive it
  // applies the filter in one pass. Idempotent-ish — cheap to send.
  function sendLoading(active) {
    post({ type: "willkarte:loading", active: !!active });
  }
  async function runSweep(gen) {
    sweepingGen = gen;
    sendLoading(true);
    renderCount(); // counter → "Filter lädt …"
    try {
      while (gen === sweepGen) {
        // Re-scan `current` each round so pages that streamed in mid-sweep are
        // picked up. detailCache dedupes, so already-fetched ads are skipped.
        const pending = current.filter((l) => l.url && !detailCache.has(l.id));
        if (!pending.length) break;
        const batch = pending.slice(0, SWEEP_CONCURRENCY);
        await Promise.all(batch.map((l) => fetchDetail(l.id, l.url)));
        updateAvailStatus();
      }
    } finally {
      if (sweepingGen === gen) sweepingGen = -1;
      if (gen === sweepGen) {
        updateAvailStatus();
        sendLoading(false); // sweep for the current gen finished → unfreeze + filter
        renderCount(); // counter → "N ausgeblendet"
      }
    }
  }
  // Start a sweep for the current gen unless one is already running for it. When
  // applyAvailFilter/startLoading bumped sweepGen, any old loop exits on its next
  // check and this starts the fresh one.
  function kickSweep() {
    if (!availFilterOn()) return;
    if (sweepingGen === sweepGen) return; // already sweeping the current gen
    runSweep(sweepGen);
  }
  function sendAvailFilter() {
    post({ type: "willkarte:availfilter", from: availFilterFrom, to: availFilterTo });
  }
  // Read both month dropdowns (value "yyyy-mm" or "" = off) and (re)apply.
  function applyAvailFilter() {
    availFilterFrom = availFrom.value || null;
    availFilterTo = availDate.value || null;
    refreshFilterBtn();
    sweepGen++; // cancel any running sweep
    if (!availFilterOn()) sendLoading(false); // clearing: unfreeze the map now
    sendAvailFilter();
    updateAvailStatus();
    renderCount();
    kickSweep(); // no-op if the filter was just cleared
  }
  availFrom.addEventListener("change", applyAvailFilter);
  availDate.addEventListener("change", applyAvailFilter);

  // ---- "Veröffentlicht / geändert" filter -------------------------------
  // ONE slider, fixed non-linear stops — cheap (PUBLISHED is in the search JSON, so
  // no fetch and no map freeze). Each stop is mutually exclusive and is either a
  // day-window (`days`) or "seit letztem Besuch" (`visit`). Both map to the same
  // message `willkarte:pubfilter` {maxAgeDays, sinceTs}: a day stop sets maxAgeDays,
  // the visit stop sets sinceTs (the prior-page-load baseline) — never both.
  const pubRange = overlay.querySelector("#willkarte-pub-range");
  const pubVal = overlay.querySelector("#willkarte-pub-val");
  const PUB_STOPS = [
    { label: "Alle" }, // off
    { visit: true, label: "Letzter Besuch" },
    { days: 1, label: "Heute" },
    { days: 2, label: "2 Tage" },
    { days: 3, label: "3 Tage" },
    { days: 7, label: "7 Tage" },
    { days: 14, label: "14 Tage" },
    { days: 30, label: "30 Tage" },
  ];
  let pubMaxAgeDays = 0; // 0 = no age limit
  let pubNewOnly = false; // "seit letztem Besuch" stop selected

  function refreshFilterBtn() {
    // The "Filter" button reads as active if ANY filter is on.
    const on = availFilterOn() || pubMaxAgeDays > 0 || pubNewOnly || floorSel.size > 0;
    filterBtn.classList.toggle("is-filtered", on);
  }
  function sendPubFilter() {
    post({
      type: "willkarte:pubfilter",
      maxAgeDays: pubMaxAgeDays,
      sinceTs: pubNewOnly ? prevVisitTs : null,
    });
  }
  pubRange.addEventListener("input", () => {
    const stop = PUB_STOPS[Number(pubRange.value)] || PUB_STOPS[0];
    pubMaxAgeDays = stop.days || 0;
    pubNewOnly = !!stop.visit;
    pubVal.textContent = stop.label;
    refreshFilterBtn();
    sendPubFilter();
    renderCount();
  });

  // ---- Stockwerk (floor) filter -----------------------------------------
  // Multi-select chips. Empty set = off (show all floors). Sends the selected keys
  // to the map, which maps each listing's FLOOR to a key and hides the mismatches.
  // Cheap: FLOOR is in the search JSON (no fetch/freeze).
  const floorChips = overlay.querySelectorAll(".willkarte-floor-chip[data-floor]");
  const floorSel = new Set(); // selected keys: eg / 1 / 2 / 3 / 4plus / dg
  function sendFloorFilter() {
    post({ type: "willkarte:floorfilter", floors: [...floorSel] });
  }
  for (const chip of floorChips) {
    chip.addEventListener("click", () => {
      const k = chip.dataset.floor;
      if (floorSel.has(k)) floorSel.delete(k);
      else floorSel.add(k);
      chip.classList.toggle("is-on", floorSel.has(k));
      chip.setAttribute("aria-checked", String(floorSel.has(k)));
      refreshFilterBtn();
      sendFloorFilter();
      renderCount();
    });
  }

  toggle.addEventListener("click", openMap);
  overlay.querySelector("#willkarte-close").addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    closeMap();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && overlay.classList.contains("willkarte-open")) closeMap();
  });
  // Back button while the map is open: close it (consuming our pushed entry).
  window.addEventListener("popstate", () => {
    if (overlay.classList.contains("willkarte-open")) hideMap();
  });

  // The top-left counter. Base = "N / total Inserate". When any extra filter is on
  // it also shows how many are ruled out (reported by the map, which owns the
  // filtering), e.g. "· 12 ausgeblendet". While the availability sweep runs it
  // reads "· Filter lädt … (K ausgeblendet)".
  let lastLoaded = 0;
  let filterHidden = 0; // flats hidden by ANY extra filter (from the map)
  function anyFilterOn() {
    return availFilterOn() || pubMaxAgeDays > 0 || pubNewOnly || floorSel.size > 0;
  }
  function renderCount() {
    const capped = lastLoaded >= MAX_LISTINGS && total && total > MAX_LISTINGS;
    let txt =
      lastLoaded + (total ? " / " + total : "") + " Inserate" +
      (capped ? " (Limit " + MAX_LISTINGS + ")" : "");
    if (anyFilterOn()) {
      // The availability sweep is the only slow part; show its progress while it runs.
      const availLoading = availFilterOn() && sweepingGen === sweepGen;
      txt += availLoading
        ? " · Filter lädt … (" + filterHidden + " ausgeblendet)"
        : " · " + filterHidden + " ausgeblendet";
    }
    overlay.querySelector("#willkarte-count").textContent = txt;
  }
  function setCount(loaded) {
    lastLoaded = loaded;
    setPillMax(loaded);
    renderCount();
  }

  // ---- Messaging with the map iframe ------------------------------------
  let iframeReady = false;
  function post(msg) {
    if (iframe.contentWindow) iframe.contentWindow.postMessage(msg, "*");
  }
  function sendListings() {
    post({ type: "willkarte:listings", listings: current, loadId: loadGen });
  }

  window.addEventListener("message", (e) => {
    const d = e.data;
    if (d?.type === "willkarte:ready") {
      iframeReady = true;
      sendMaxPills();
      sendListings();
      sendSaved();
      sendHidden();
      sendView();
      sendAvailFilter();
      sendPubFilter();
      sendFloorFilter();
    }
    if (d?.type === "willkarte:save") setSaved(d.id, d.save);
    if (d?.type === "willkarte:hide") setHidden(d.id, d.hide);
    if (d?.type === "willkarte:fetchDetail") fetchDetail(d.id, d.url);
    if (d?.type === "willkarte:availcount") {
      filterHidden = d.hidden || 0;
      renderCount();
    }
  });

  // Availability ("verfügbar ab") lives ONLY on the ad's detail page, not in the
  // search-list JSON. So fetch it lazily when a popup opens, cache per id, and
  // answer the iframe. AVAILABLE_NOW is the label ("ab sofort"); AVAILABLE_DATE a
  // concrete date. One request per ad you actually look at.
  const detailCache = new Map(); // id -> { available } | "pending"
  async function fetchDetail(id, url) {
    if (!url || detailCache.get(id) === "pending") return;
    if (detailCache.has(id)) {
      post({ type: "willkarte:detail", id, available: detailCache.get(id).available });
      return;
    }
    detailCache.set(id, "pending");
    let available = null;
    try {
      const res = await fetch(url, { credentials: "include" });
      console.log("[willkarte] detail fetch", id, url, "->", res.status, res.ok);
      if (res.ok) {
        const html = await res.text();
        const doc = new DOMParser().parseFromString(html, "text/html");
        const root = rootFrom(doc);
        console.log("[willkarte] detail __NEXT_DATA__ present?", !!doc.getElementById("__NEXT_DATA__"), "root?", !!root);
        const attrs = {};
        (function walk(o) {
          if (!o || typeof o !== "object") return;
          if (typeof o.name === "string" && Array.isArray(o.values)) {
            attrs[o.name] = o.values[0];
            return;
          }
          for (const k in o) walk(o[k]);
        })(root?.props?.pageProps || root);
        available = attrs.AVAILABLE_NOW || attrs.AVAILABLE_DATE || null;
        console.log("[willkarte] detail attrs found:", Object.keys(attrs).length,
          "AVAILABLE_NOW=", attrs.AVAILABLE_NOW, "AVAILABLE_DATE=", attrs.AVAILABLE_DATE);
      }
    } catch (e) {
      console.log("[willkarte] detail fetch failed for", id, e);
    }
    detailCache.set(id, { available });
    console.log("[willkarte] detail reply", id, "available=", available);
    post({ type: "willkarte:detail", id, available });
  }

  // ---- Loading ----------------------------------------------------------
  function startLoading() {
    const gen = ++loadGen; // invalidates any load still running
    current = [];
    byId = new Map();
    total = null;
    sweepGen++; // stop the old sweep; loadAll's kickSweep restarts it if filtering
    updateAvailStatus();
    loadAll(gen);
    loadSaved(); // the Merkliste may have changed since the last open
    loadHidden(); // hidden list may have changed in another tab
  }

  async function loadAll(gen) {
    let pageSize = null;
    for (let page = 1; page <= MAX_PAGES; page++) {
      if (gen !== loadGen) return; // a newer load took over
      if (byId.size >= MAX_LISTINGS) break;
      if (total && byId.size >= total) break;

      const url = new URL(location.href);
      url.searchParams.set("rows", String(ROWS_PER_PAGE));
      url.searchParams.set("page", String(page));

      let root;
      try {
        const res = await fetch(url.toString(), { credentials: "include" });
        if (!res.ok) break;
        root = rootFrom(new DOMParser().parseFromString(await res.text(), "text/html"));
      } catch (e) {
        console.log("[willkarte] page", page, "fetch failed:", e);
        break;
      }
      if (gen !== loadGen) return;

      if (page === 1) total = totalOf(searchResultOf(root)); // fresh count
      const pageListings = parseListings(root);
      if (!pageListings.length) break;
      if (pageSize === null) pageSize = pageListings.length;

      for (const l of pageListings) byId.set(l.id, l);
      current = [...byId.values()];
      if (iframeReady) sendListings();
      setCount(current.length);
      kickSweep(); // if the date filter is on, fetch the new page's dates too

      // Fewer results than the first page means we've reached the end.
      if (pageListings.length < pageSize) break;
      await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
    }
  }
})();
