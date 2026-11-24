const BOOKMARKS_STORAGE_KEY = 'yamal_bookmarks_v1';

const DEFAULT_BOOKMARKS = [
  { id: 'bm-youtube', name: 'YouTube', domain: 'youtube.com', url: 'https://www.youtube.com/' },
  { id: 'bm-tiktok', name: 'TikTok', domain: 'tiktok.com', url: 'https://www.tiktok.com/' },
  { id: 'bm-wikipedia', name: 'Wikipedia', domain: 'en.wikipedia.org', url: 'https://en.wikipedia.org/wiki/Main_Page' },
  { id: 'bm-bing', name: 'Bing Search', domain: 'bing.com', url: 'https://www.bing.com/' },
  { id: 'bm-coolmath', name: 'Coolmath Games', domain: 'coolmathgames.com', url: 'https://www.coolmathgames.com/' },
  { id: 'bm-poki', name: 'Poki Games', domain: 'poki.com', url: 'https://poki.com/' },
  { id: 'bm-mdn', name: 'MDN Web Docs', domain: 'developer.mozilla.org', url: 'https://developer.mozilla.org/en-US/' },
  { id: 'bm-archive', name: 'Internet Archive', domain: 'archive.org', url: 'https://archive.org/' },
  { id: 'bm-github', name: 'GitHub', domain: 'github.com', url: 'https://github.com/' },
  { id: 'bm-bbc', name: 'BBC News', domain: 'bbc.com', url: 'https://www.bbc.com/news' },
];

function normalizeUrlComparable(url) {
  if (!url || typeof url !== 'string') return '';
  const trimmed = url.trim();
  if (!trimmed) return '';
  try {
    return new URL(trimmed).toString();
  } catch {
    return trimmed;
  }
}

function normalizeBookmarkUrl(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  if (/^(javascript|data|vbscript|file|blob):/i.test(trimmed)) return null;
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (!parsed.hostname || !parsed.hostname.includes('.')) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

export function createUnblockerController({ onGamesTabOpen, history, cloak } = {}) {
  const unblockerShell = document.getElementById('unblocker-app');
  const tabsEl = document.getElementById('browser-tabs');
  const gamesHubTabBtn = document.getElementById('games-hub-tab-btn');
  const gamesMenuBtn = document.getElementById('games-menu-btn');
  const gamesView = document.getElementById('games-view');
  const newTabBtn = document.getElementById('browser-new-tab-btn');
  const backBtn = document.getElementById('browser-back-btn');
  const forwardBtn = document.getElementById('browser-forward-btn');
  const reloadBtn = document.getElementById('browser-reload-btn');
  const homeBtn = document.getElementById('browser-home-btn');
  const addressForm = document.getElementById('browser-address-form');
  const addressInput = document.getElementById('browser-address-input');
  const bookmarkBtn = document.getElementById('browser-bookmark-btn');
  const loadingBar = document.getElementById('browser-loading-bar');
  const startPage = document.getElementById('browser-start-page');
  const startClockEl = document.getElementById('start-clock');
  const startDateEl = document.getElementById('start-date');
  const startSearchForm = document.getElementById('start-search-form');
  const startSearchInput = document.getElementById('start-search-input');
  const bookmarksGrid = document.getElementById('bookmarks-grid');
  const bookmarksEmptyMsg = document.getElementById('bookmarks-empty-msg');
  const addBookmarkToggleBtn = document.getElementById('add-bookmark-toggle-btn');
  const addBookmarkForm = document.getElementById('add-bookmark-form');
  const bookmarkNameInput = document.getElementById('bookmark-name-input');
  const bookmarkUrlInput = document.getElementById('bookmark-url-input');
  const addBookmarkCancelBtn = document.getElementById('add-bookmark-cancel-btn');
  const addBookmarkError = document.getElementById('add-bookmark-error');
  const framesContainer = document.getElementById('browser-frames-container');
  const iframesStage = document.getElementById('browser-iframes-stage');
  const frameActionTitle = document.getElementById('frame-action-title');
  const frameActionStatus = document.getElementById('frame-action-status');
  const frameBackGamesBtn = document.getElementById('frame-back-games-btn');
  const frameReloadBtn = document.getElementById('frame-reload-btn');
  const frameAboutBlankBtn = document.getElementById('frame-about-blank-btn');
  const frameFullscreenBtn = document.getElementById('frame-fullscreen-btn');
  const panicOverlay = document.getElementById('panic-overlay');

  let tabs = [];
  let activeTabId = null;
  let nextTabSeq = 1;
  let searchEngine = 'bing';
  let isGamesActive = false;
  let bookmarks = loadBookmarks();
  let frameStatusTimer = null;

  function updateStartClock() {
    if (!startClockEl && !startDateEl) return;
    const now = new Date();
    if (startClockEl) {
      startClockEl.textContent = now.toLocaleTimeString([], {
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
      });
    }
    if (startDateEl) {
      startDateEl.textContent = now.toLocaleDateString([], {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric',
      });
    }
  }

  updateStartClock();
  window.setInterval(updateStartClock, 1000);

  function setSearchEngine(engine) {
    searchEngine = engine === 'wikipedia' ? 'wikipedia' : 'bing';
  }

  function resolveUserInputToUrl(raw) {
    const trimmed = String(raw || '').trim();
    if (!trimmed) return null;

    if (/^https?:\/\//i.test(trimmed)) {
      return normalizeUrlComparable(trimmed);
    }
    if (!/\s/.test(trimmed) && trimmed.includes('.')) {
      return normalizeUrlComparable(`https://${trimmed}`);
    }
    if (searchEngine === 'wikipedia') {
      return `https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(trimmed)}`;
    }
    return `https://www.bing.com/search?q=${encodeURIComponent(trimmed)}`;
  }

  function proxyEndpointFor(targetUrl) {
    return `/api/proxy?url=${encodeURIComponent(targetUrl)}`;
  }

  function getActiveTab() {
    return tabs.find((t) => t.id === activeTabId) || null;
  }

  function getDisplayHost(url) {
    if (!url) return 'New Tab';
    try {
      const u = new URL(url);
      return u.hostname.replace(/^www\./, '');
    } catch {
      return url;
    }
  }

  function saveTabsSession() {
    if (!history || typeof history.saveTabsSnapshot !== 'function') return;
    history.saveTabsSnapshot({
      nextTabSeq,
      activeTabId,
      isGamesActive,
      tabs: tabs.map((t) => ({
        id: t.id,
        title: t.title,
        customTitle: t.customTitle,
        isGame: Boolean(t.isGame),
        currentUrl: t.currentUrl,
        history: Array.isArray(t.history) ? t.history.slice(-80) : [],
        historyIndex: typeof t.historyIndex === 'number' ? t.historyIndex : -1,
      })),
    });
  }

  function renderTabs() {
    if (gamesHubTabBtn) {
      gamesHubTabBtn.classList.toggle('is-active', isGamesActive);
      gamesHubTabBtn.setAttribute('aria-selected', isGamesActive ? 'true' : 'false');
    }
    if (gamesMenuBtn) {
      gamesMenuBtn.classList.toggle('is-active', isGamesActive);
    }

    tabsEl.innerHTML = '';
    tabs.forEach((tab) => {
      const isSelected = !isGamesActive && tab.id === activeTabId;
      const tabBtn = document.createElement('div');
      tabBtn.className = `browser-tab${isSelected ? ' is-active' : ''}`;
      tabBtn.setAttribute('role', 'tab');
      tabBtn.setAttribute('aria-selected', isSelected ? 'true' : 'false');

      const titleSpan = document.createElement('span');
      titleSpan.className = 'tab-title-text';
      titleSpan.textContent = tab.title || getDisplayHost(tab.currentUrl);
      tabBtn.appendChild(titleSpan);

      tabBtn.addEventListener('click', () => selectTab(tab.id));

      if (tabs.length > 1) {
        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'tab-close-btn';
        closeBtn.setAttribute('aria-label', `Close ${titleSpan.textContent}`);
        closeBtn.textContent = '×';
        closeBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          closeTab(tab.id);
        });
        tabBtn.appendChild(closeBtn);
      }

      tabsEl.appendChild(tabBtn);
    });
  }

  function canGoBack(tab) {
    if (!tab || !Array.isArray(tab.history) || tab.history.length === 0) return false;
    if (tab.currentUrl) return tab.historyIndex > 0;
    return tab.historyIndex >= 0;
  }

  function canGoForward(tab) {
    if (!tab || !Array.isArray(tab.history)) return false;
    return tab.historyIndex < tab.history.length - 1;
  }

  function syncBookmarkButton() {
    if (!bookmarkBtn) return;
    const tab = !isGamesActive ? getActiveTab() : null;
    if (!tab || !tab.currentUrl) {
      bookmarkBtn.disabled = true;
      bookmarkBtn.textContent = '☆';
      bookmarkBtn.classList.remove('is-bookmarked');
      bookmarkBtn.title = 'Bookmark current page (Alt+D)';
      bookmarkBtn.setAttribute('aria-pressed', 'false');
      return;
    }
    const saved = isUrlBookmarked(tab.currentUrl);
    bookmarkBtn.disabled = false;
    bookmarkBtn.textContent = saved ? '★' : '☆';
    bookmarkBtn.classList.toggle('is-bookmarked', saved);
    bookmarkBtn.title = saved ? 'Remove bookmark (Alt+D)' : 'Bookmark this page (Alt+D)';
    bookmarkBtn.setAttribute('aria-pressed', saved ? 'true' : 'false');
  }

  function showFrameStatus(message) {
    if (!frameActionStatus) return;
    if (frameStatusTimer) {
      window.clearTimeout(frameStatusTimer);
      frameStatusTimer = null;
    }
    frameActionStatus.textContent = message;
    frameActionStatus.hidden = !message;
    if (message) {
      frameStatusTimer = window.setTimeout(() => {
        frameActionStatus.hidden = true;
        frameActionStatus.textContent = '';
      }, 4000);
    }
  }

  function syncFullscreenButton() {
    if (!frameFullscreenBtn) return;
    const isFs =
      Boolean(document.fullscreenElement) ||
      (framesContainer && framesContainer.classList.contains('is-pseudo-fullscreen'));
    frameFullscreenBtn.textContent = isFs ? 'Exit Fullscreen' : 'Fullscreen';
  }

  function syncFrameActionBar() {
    const tab = !isGamesActive ? getActiveTab() : null;
    if (!tab || !tab.currentUrl) {
      if (framesContainer && framesContainer.classList.contains('is-pseudo-fullscreen')) {
        framesContainer.classList.remove('is-pseudo-fullscreen');
      }
      if (frameActionTitle) frameActionTitle.textContent = '';
      if (frameBackGamesBtn) frameBackGamesBtn.hidden = true;
      syncFullscreenButton();
      return;
    }
    if (frameActionTitle) {
      frameActionTitle.textContent = tab.title || getDisplayHost(tab.currentUrl);
    }
    if (frameBackGamesBtn) {
      frameBackGamesBtn.hidden = !tab.isGame;
    }
    syncFullscreenButton();
  }

  function syncToolbar() {
    if (isGamesActive) {
      addressInput.value = '';
      backBtn.disabled = true;
      forwardBtn.disabled = true;
      reloadBtn.disabled = true;
      backBtn.title = 'Back (Alt+Left)';
      forwardBtn.title = 'Forward (Alt+Right)';
      loadingBar.hidden = true;
      if (gamesView) gamesView.hidden = false;
      startPage.hidden = true;
      framesContainer.hidden = true;
      tabs.forEach((t) => {
        if (t.iframe) {
          t.iframe.classList.remove('is-active');
        }
      });
      syncBookmarkButton();
      syncFrameActionBar();
      return;
    }

    if (gamesView) gamesView.hidden = true;

    const tab = getActiveTab();
    if (!tab) return;

    const hasUrl = Boolean(tab.currentUrl);
    addressInput.value = tab.currentUrl || '';
    const allowBack = canGoBack(tab);
    const allowForward = canGoForward(tab);
    backBtn.disabled = !allowBack;
    forwardBtn.disabled = !allowForward;
    reloadBtn.disabled = !hasUrl;
    loadingBar.hidden = !tab.loading;

    if (allowBack) {
      const backTarget = tab.currentUrl
        ? tab.history[tab.historyIndex - 1]
        : tab.history[tab.historyIndex];
      const backLabel = (backTarget && (backTarget.title || getDisplayHost(backTarget.url))) || 'Previous';
      backBtn.title = `Back to ${backLabel} (Alt+Left)`;
    } else {
      backBtn.title = 'Back (Alt+Left)';
    }

    if (allowForward) {
      const fwdTarget = tab.history[tab.historyIndex + 1];
      const fwdLabel = (fwdTarget && (fwdTarget.title || getDisplayHost(fwdTarget.url))) || 'Next';
      forwardBtn.title = `Forward to ${fwdLabel} (Alt+Right)`;
    } else {
      forwardBtn.title = 'Forward (Alt+Right)';
    }

    if (hasUrl) {
      startPage.hidden = true;
      framesContainer.hidden = false;
    } else {
      startPage.hidden = false;
      framesContainer.hidden = true;
    }

    tabs.forEach((t) => {
      if (t.iframe) {
        t.iframe.classList.toggle('is-active', t.id === activeTabId && Boolean(t.currentUrl));
      }
    });
    syncBookmarkButton();
    syncFrameActionBar();
  }

  function ensureIframeForTab(tab) {
    if (tab.iframe) return tab.iframe;
    const iframe = document.createElement('iframe');
    iframe.className = 'proxy-iframe';
    iframe.setAttribute(
      'allow',
      'fullscreen; autoplay; encrypted-media; picture-in-picture; web-share; gamepad; pointer-lock; accelerometer; gyroscope; clipboard-read; clipboard-write'
    );
    iframe.allowFullscreen = true;
    iframe.title = `Web tab ${tab.id}`;

    iframe.addEventListener('load', () => {
      tab.loading = false;
      if (tab.id === activeTabId && !isGamesActive) {
        loadingBar.hidden = true;
      }
      renderTabs();
    });

    const stage = iframesStage || framesContainer;
    stage.appendChild(iframe);
    tab.iframe = iframe;
    return iframe;
  }

  function navigateTab(
    tab,
    rawInput,
    { pushHistory = true, navMode = pushHistory ? 'push' : 'history', customTitle = '', recordSession = true } = {}
  ) {
    const resolved = resolveUserInputToUrl(rawInput);
    if (!resolved) return;

    isGamesActive = false;
    tab.navMode = navMode;
    const displayTitle = customTitle || getDisplayHost(resolved);

    if (pushHistory) {
      tab.history = tab.history.slice(0, tab.historyIndex + 1);
      tab.history.push({
        url: resolved,
        title: displayTitle,
        timestamp: Date.now(),
      });
      tab.historyIndex = tab.history.length - 1;
      if (recordSession && history && typeof history.recordVisit === 'function') {
        history.recordVisit({ url: resolved, title: displayTitle, tabId: tab.id });
      }
    }

    tab.currentUrl = resolved;
    tab.customTitle = customTitle || '';
    tab.title = displayTitle;
    tab.loading = true;

    const iframe = ensureIframeForTab(tab);
    iframe.src = proxyEndpointFor(resolved);

    renderTabs();
    syncToolbar();
    saveTabsSession();
  }

  function createTab(initialUrl = null, customTitle = '', { isGame = false } = {}) {
    isGamesActive = false;
    const id = `tab-${nextTabSeq++}`;
    const tab = {
      id,
      title: customTitle || 'New Tab',
      customTitle: customTitle || '',
      isGame: Boolean(isGame),
      currentUrl: null,
      history: [],
      historyIndex: -1,
      navMode: 'none',
      loading: false,
      iframe: null,
    };
    tabs.push(tab);
    activeTabId = id;
    if (initialUrl) {
      navigateTab(tab, initialUrl, { customTitle });
    } else {
      renderTabs();
      syncToolbar();
      saveTabsSession();
    }
    return tab;
  }

  function openUrlInNewTab(url, title = '', { isGame = false } = {}) {
    if (!url) return;
    createTab(url, title, { isGame });
  }

  function navigateActiveTab(url, title = '') {
    if (!url) return;
    if (isGamesActive) {
      createTab(url, title);
      return;
    }
    const tab = getActiveTab();
    if (tab) {
      navigateTab(tab, url, { customTitle: title });
    } else {
      createTab(url, title);
    }
  }

  function openGamesTab() {
    isGamesActive = true;
    renderTabs();
    syncToolbar();
    saveTabsSession();
    if (typeof onGamesTabOpen === 'function') {
      onGamesTabOpen();
    }
  }

  function selectTab(id) {
    const target = tabs.find((t) => t.id === id);
    if (!target) return;
    isGamesActive = false;
    activeTabId = id;
    if (target.currentUrl && !target.iframe) {
      target.navMode = 'reload';
      target.loading = true;
      const iframe = ensureIframeForTab(target);
      iframe.src = proxyEndpointFor(target.currentUrl);
    }
    renderTabs();
    syncToolbar();
    saveTabsSession();
  }

  function closeTab(id) {
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;
    const [removed] = tabs.splice(idx, 1);
    if (removed.iframe) {
      removed.iframe.remove();
    }
    if (tabs.length === 0) {
      createTab();
      return;
    }
    if (activeTabId === id) {
      const nextIdx = Math.min(idx, tabs.length - 1);
      activeTabId = tabs[nextIdx].id;
      const nextTab = tabs[nextIdx];
      if (nextTab && nextTab.currentUrl && !nextTab.iframe) {
        nextTab.navMode = 'reload';
        nextTab.loading = true;
        const iframe = ensureIframeForTab(nextTab);
        iframe.src = proxyEndpointFor(nextTab.currentUrl);
      }
    }
    renderTabs();
    syncToolbar();
    saveTabsSession();
  }

  function goBack() {
    if (isGamesActive) return;
    const tab = getActiveTab();
    if (!canGoBack(tab)) return;
    if (tab.currentUrl) {
      tab.historyIndex -= 1;
    }
    const entry = tab.history[tab.historyIndex];
    if (!entry || !entry.url) return;
    navigateTab(tab, entry.url, {
      pushHistory: false,
      navMode: 'history',
      customTitle: entry.title || '',
      recordSession: false,
    });
  }

  function goForward() {
    if (isGamesActive) return;
    const tab = getActiveTab();
    if (!canGoForward(tab)) return;
    tab.historyIndex += 1;
    const entry = tab.history[tab.historyIndex];
    if (!entry || !entry.url) return;
    navigateTab(tab, entry.url, {
      pushHistory: false,
      navMode: 'history',
      customTitle: entry.title || '',
      recordSession: false,
    });
  }

  function jumpToTabIndex(index) {
    const tab = getActiveTab();
    if (!tab || !Array.isArray(tab.history)) return;
    if (index < 0 || index >= tab.history.length) return;
    isGamesActive = false;
    tab.historyIndex = index;
    const entry = tab.history[index];
    if (!entry || !entry.url) return;
    navigateTab(tab, entry.url, {
      pushHistory: false,
      navMode: 'history',
      customTitle: entry.title || '',
      recordSession: false,
    });
  }

  function restoreTabsFromSession() {
    if (!history || typeof history.loadTabsSnapshot !== 'function') return false;
    const snap = history.loadTabsSnapshot();
    if (!snap || !Array.isArray(snap.tabs) || snap.tabs.length === 0) return false;

    const restoredTabs = [];
    for (const rawTab of snap.tabs) {
      if (!rawTab || typeof rawTab.id !== 'string') continue;
      const rawHistory = Array.isArray(rawTab.history)
        ? rawTab.history
            .map((item) => {
              if (typeof item === 'string') {
                return { url: item, title: getDisplayHost(item), timestamp: Date.now() };
              }
              if (item && typeof item.url === 'string') {
                return {
                  url: item.url,
                  title: item.title || getDisplayHost(item.url),
                  timestamp: typeof item.timestamp === 'number' ? item.timestamp : Date.now(),
                };
              }
              return null;
            })
            .filter(Boolean)
        : [];

      const clampedIndex =
        rawHistory.length === 0
          ? -1
          : Math.max(-1, Math.min(rawHistory.length - 1, Number(rawTab.historyIndex ?? rawHistory.length - 1)));

      restoredTabs.push({
        id: rawTab.id,
        title: typeof rawTab.title === 'string' ? rawTab.title : 'New Tab',
        customTitle: typeof rawTab.customTitle === 'string' ? rawTab.customTitle : '',
        isGame: Boolean(rawTab.isGame),
        currentUrl: typeof rawTab.currentUrl === 'string' ? rawTab.currentUrl : null,
        history: rawHistory,
        historyIndex: clampedIndex,
        navMode: 'none',
        loading: false,
        iframe: null,
      });
    }

    if (restoredTabs.length === 0) return false;

    tabs = restoredTabs;
    nextTabSeq = Math.max(Number(snap.nextTabSeq) || 1, restoredTabs.length + 1);
    activeTabId = restoredTabs.some((t) => t.id === snap.activeTabId)
      ? snap.activeTabId
      : restoredTabs[0].id;
    isGamesActive = Boolean(snap.isGamesActive);

    const active = getActiveTab();
    if (!isGamesActive && active && active.currentUrl) {
      active.navMode = 'reload';
      active.loading = true;
      const iframe = ensureIframeForTab(active);
      iframe.src = proxyEndpointFor(active.currentUrl);
    }

    renderTabs();
    syncToolbar();
    if (isGamesActive && typeof onGamesTabOpen === 'function') {
      onGamesTabOpen();
    }
    return true;
  }

  function loadBookmarks() {
    try {
      const raw = localStorage.getItem(BOOKMARKS_STORAGE_KEY);
      if (!raw) return DEFAULT_BOOKMARKS.map((b) => ({ ...b }));
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return DEFAULT_BOOKMARKS.map((b) => ({ ...b }));
      return parsed
        .filter((item) => item && typeof item.url === 'string' && normalizeBookmarkUrl(item.url))
        .map((item, idx) => {
          const cleanUrl = normalizeBookmarkUrl(item.url);
          const domain = getDisplayHost(cleanUrl);
          return {
            id: typeof item.id === 'string' ? item.id : `bm-${Date.now()}-${idx}`,
            name: (typeof item.name === 'string' && item.name.trim()) || domain,
            domain,
            url: cleanUrl,
          };
        });
    } catch {
      return DEFAULT_BOOKMARKS.map((b) => ({ ...b }));
    }
  }

  function saveBookmarks() {
    try {
      localStorage.setItem(BOOKMARKS_STORAGE_KEY, JSON.stringify(bookmarks));
    } catch {
      // Ignore storage quota errors
    }
  }

  function isUrlBookmarked(url) {
    const norm = normalizeUrlComparable(url);
    if (!norm) return false;
    return bookmarks.some((bm) => normalizeUrlComparable(bm.url) === norm);
  }

  function addBookmark({ name, url }) {
    const normalized = normalizeBookmarkUrl(url);
    if (!normalized) {
      return { ok: false, error: 'Enter a valid website URL (for example, example.com).' };
    }
    const domain = getDisplayHost(normalized);
    const label = String(name || '').trim() || domain;
    const existing = bookmarks.find((bm) => normalizeUrlComparable(bm.url) === normalized);
    if (existing) {
      existing.name = label;
      existing.domain = domain;
    } else {
      bookmarks.unshift({
        id: `bm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: label,
        domain,
        url: normalized,
      });
    }
    saveBookmarks();
    renderBookmarks();
    syncBookmarkButton();
    return { ok: true };
  }

  function removeBookmarkById(id) {
    bookmarks = bookmarks.filter((bm) => bm.id !== id);
    saveBookmarks();
    renderBookmarks();
    syncBookmarkButton();
  }

  function toggleCurrentPageBookmark() {
    if (isGamesActive) return;
    const tab = getActiveTab();
    if (!tab || !tab.currentUrl) return;
    const norm = normalizeUrlComparable(tab.currentUrl);
    const existing = bookmarks.find((bm) => normalizeUrlComparable(bm.url) === norm);
    if (existing) {
      removeBookmarkById(existing.id);
    } else {
      addBookmark({ name: tab.title || getDisplayHost(tab.currentUrl), url: tab.currentUrl });
    }
  }

  function renderBookmarks() {
    bookmarksGrid.innerHTML = '';
    if (bookmarksEmptyMsg) {
      bookmarksEmptyMsg.hidden = bookmarks.length > 0;
    }
    bookmarks.forEach((bm) => {
      const card = document.createElement('div');
      card.className = 'bookmark-card';

      const openBtn = document.createElement('button');
      openBtn.type = 'button';
      openBtn.className = 'bookmark-card-open';
      openBtn.title = bm.url;

      const nameEl = document.createElement('span');
      nameEl.className = 'bookmark-name';
      nameEl.textContent = bm.name;

      const domainEl = document.createElement('span');
      domainEl.className = 'bookmark-domain';
      domainEl.textContent = bm.domain;

      openBtn.append(nameEl, domainEl);
      openBtn.addEventListener('click', () => {
        const tab = getActiveTab();
        if (tab) {
          navigateTab(tab, bm.url, { customTitle: bm.name });
        }
      });

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'bookmark-remove-btn';
      removeBtn.setAttribute('aria-label', `Remove ${bm.name} bookmark`);
      removeBtn.title = 'Remove link';
      removeBtn.textContent = '×';
      removeBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        removeBookmarkById(bm.id);
      });

      card.append(openBtn, removeBtn);
      bookmarksGrid.appendChild(card);
    });
  }

  function open() {
    unblockerShell.hidden = false;
    if (tabs.length === 0) {
      const restored = restoreTabsFromSession();
      if (!restored) {
        createTab();
      }
    } else {
      renderTabs();
      syncToolbar();
    }
    window.setTimeout(() => {
      const tab = getActiveTab();
      if (tab && !tab.currentUrl && !isGamesActive) {
        startSearchInput.focus();
      } else {
        addressInput.focus();
      }
    }, 30);
  }

  addressForm.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const val = addressInput.value.trim();
    if (!val) return;
    if (isGamesActive) {
      createTab(val);
      return;
    }
    const tab = getActiveTab();
    if (tab) {
      navigateTab(tab, val);
    }
  });

  if (gamesHubTabBtn) {
    gamesHubTabBtn.addEventListener('click', openGamesTab);
  }
  if (gamesMenuBtn) {
    gamesMenuBtn.addEventListener('click', openGamesTab);
  }

  startSearchForm.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const tab = getActiveTab();
    if (tab && startSearchInput.value.trim()) {
      navigateTab(tab, startSearchInput.value);
      startSearchInput.value = '';
    }
  });

  newTabBtn.addEventListener('click', () => {
    createTab();
    startSearchInput.focus();
  });

  backBtn.addEventListener('click', goBack);
  forwardBtn.addEventListener('click', goForward);

  function reloadActiveTab() {
    const tab = getActiveTab();
    if (!tab || !tab.currentUrl) return;
    tab.navMode = 'reload';
    tab.loading = true;
    syncToolbar();
    if (tab.iframe) {
      tab.iframe.src = proxyEndpointFor(tab.currentUrl);
    }
  }

  async function toggleActiveFrameFullscreen() {
    const tab = getActiveTab();
    if (!tab || !tab.currentUrl) return;

    if (document.fullscreenElement) {
      try {
        await document.exitFullscreen();
      } catch {
        // Ignore exit errors
      }
      syncFullscreenButton();
      return;
    }

    if (framesContainer && framesContainer.classList.contains('is-pseudo-fullscreen')) {
      framesContainer.classList.remove('is-pseudo-fullscreen');
      syncFullscreenButton();
      return;
    }

    const target = tab.iframe || framesContainer;
    if (target && typeof target.requestFullscreen === 'function') {
      try {
        await target.requestFullscreen();
        syncFullscreenButton();
        return;
      } catch {
        // Fall back to viewport-filling mode when browser blocks nested fullscreen
      }
    }

    if (framesContainer) {
      framesContainer.classList.add('is-pseudo-fullscreen');
      syncFullscreenButton();
    }
  }

  function openCurrentPageInAboutBlank() {
    const tab = getActiveTab();
    if (!tab || !tab.currentUrl) return;

    const win = window.open('about:blank', '_blank');
    if (!win) {
      showFrameStatus('Popup blocked — allow popups for this site to open in about:blank.');
      return;
    }

    const cloakInfo =
      cloak && typeof cloak.getActiveCloakInfo === 'function'
        ? cloak.getActiveCloakInfo()
        : { title: tab.title || 'App', iconUri: '' };

    const safeTitle = String(cloakInfo.title || tab.title || 'App').replace(/[<>&"]/g, '');
    const iconLink = cloakInfo.iconUri
      ? `<link rel="icon" type="image/svg+xml" href="${cloakInfo.iconUri}" />`
      : '';
    const fullProxySrc = new URL(proxyEndpointFor(tab.currentUrl), window.location.href).toString();

    const doc = win.document;
    doc.open();
    doc.write(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${safeTitle}</title>
  ${iconLink}
  <style>
    html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: #0b1120; }
    iframe { width: 100%; height: 100%; border: 0; display: block; }
  </style>
</head>
<body>
  <iframe src="${fullProxySrc.replace(/"/g, '&quot;')}" allow="fullscreen; autoplay; encrypted-media; picture-in-picture; web-share; gamepad; pointer-lock; accelerometer; gyroscope; clipboard-read; clipboard-write" allowfullscreen></iframe>
</body>
</html>`);
    doc.close();
    showFrameStatus('Opened in about:blank.');
  }

  reloadBtn.addEventListener('click', reloadActiveTab);

  if (frameBackGamesBtn) {
    frameBackGamesBtn.addEventListener('click', openGamesTab);
  }
  if (frameReloadBtn) {
    frameReloadBtn.addEventListener('click', reloadActiveTab);
  }
  if (frameAboutBlankBtn) {
    frameAboutBlankBtn.addEventListener('click', openCurrentPageInAboutBlank);
  }
  if (frameFullscreenBtn) {
    frameFullscreenBtn.addEventListener('click', () => {
      void toggleActiveFrameFullscreen();
    });
  }

  document.addEventListener('fullscreenchange', syncFullscreenButton);

  homeBtn.addEventListener('click', () => {
    isGamesActive = false;
    const tab = getActiveTab();
    if (!tab) return;
    tab.currentUrl = null;
    tab.customTitle = '';
    tab.isGame = false;
    tab.title = 'New Tab';
    tab.navMode = 'none';
    tab.loading = false;
    if (tab.iframe) {
      tab.iframe.removeAttribute('src');
    }
    renderTabs();
    syncToolbar();
    saveTabsSession();
    startSearchInput.focus();
  });

  if (bookmarkBtn) {
    bookmarkBtn.addEventListener('click', toggleCurrentPageBookmark);
  }

  function closeAddBookmarkForm() {
    if (!addBookmarkForm) return;
    addBookmarkForm.hidden = true;
    addBookmarkForm.reset();
    if (addBookmarkError) {
      addBookmarkError.hidden = true;
      addBookmarkError.textContent = '';
    }
  }

  if (addBookmarkToggleBtn && addBookmarkForm) {
    addBookmarkToggleBtn.addEventListener('click', () => {
      if (addBookmarkForm.hidden) {
        addBookmarkForm.hidden = false;
        if (bookmarkUrlInput) {
          window.setTimeout(() => bookmarkUrlInput.focus(), 20);
        }
      } else {
        closeAddBookmarkForm();
      }
    });
  }

  if (addBookmarkCancelBtn) {
    addBookmarkCancelBtn.addEventListener('click', closeAddBookmarkForm);
  }

  if (addBookmarkForm) {
    addBookmarkForm.addEventListener('submit', (ev) => {
      ev.preventDefault();
      if (addBookmarkError) {
        addBookmarkError.hidden = true;
        addBookmarkError.textContent = '';
      }
      const res = addBookmark({
        name: bookmarkNameInput ? bookmarkNameInput.value : '',
        url: bookmarkUrlInput ? bookmarkUrlInput.value : '',
      });
      if (!res.ok) {
        if (addBookmarkError) {
          addBookmarkError.textContent = res.error;
          addBookmarkError.hidden = false;
        }
        return;
      }
      closeAddBookmarkForm();
    });
  }

  document.addEventListener('keydown', (ev) => {
    if (panicOverlay && !panicOverlay.hidden) return;
    if (ev.key === 'Escape' && framesContainer && framesContainer.classList.contains('is-pseudo-fullscreen')) {
      framesContainer.classList.remove('is-pseudo-fullscreen');
      syncFullscreenButton();
      return;
    }
    if (ev.altKey && ev.key === 'ArrowLeft') {
      ev.preventDefault();
      goBack();
    } else if (ev.altKey && ev.key === 'ArrowRight') {
      ev.preventDefault();
      goForward();
    } else if (ev.altKey && ev.key.toLowerCase() === 'h' && history) {
      ev.preventDefault();
      history.openModal();
    } else if (ev.altKey && ev.key.toLowerCase() === 'd') {
      ev.preventDefault();
      toggleCurrentPageBookmark();
    }
  });

  window.addEventListener('message', (ev) => {
    if (!ev.data || ev.data.type !== 'unblocker:loaded') return;
    const matchingTab = tabs.find((t) => t.iframe && t.iframe.contentWindow === ev.source);
    if (!matchingTab) return;

    const reportedUrl = normalizeUrlComparable(typeof ev.data.url === 'string' ? ev.data.url : '');
    const reportedTitle = typeof ev.data.title === 'string' ? ev.data.title.trim() : '';
    const hasRealTitle = Boolean(reportedTitle && reportedTitle !== reportedUrl);
    const navMode = matchingTab.navMode;
    matchingTab.navMode = 'none';

    if (reportedUrl) {
      const currentNorm = normalizeUrlComparable(matchingTab.currentUrl);

      if (navMode === 'history' || navMode === 'reload') {
        matchingTab.currentUrl = reportedUrl;
        if (matchingTab.history[matchingTab.historyIndex]) {
          matchingTab.history[matchingTab.historyIndex].url = reportedUrl;
        }
      } else if (navMode === 'push') {
        matchingTab.currentUrl = reportedUrl;
        if (matchingTab.history[matchingTab.historyIndex]) {
          matchingTab.history[matchingTab.historyIndex].url = reportedUrl;
        }
      } else if (reportedUrl !== currentNorm) {
        // In-frame link click or SPA navigation
        matchingTab.history = matchingTab.history.slice(0, matchingTab.historyIndex + 1);
        const entryTitle = hasRealTitle ? reportedTitle : getDisplayHost(reportedUrl);
        matchingTab.history.push({
          url: reportedUrl,
          title: entryTitle,
          timestamp: Date.now(),
        });
        matchingTab.historyIndex = matchingTab.history.length - 1;
        matchingTab.currentUrl = reportedUrl;
        matchingTab.customTitle = '';
        if (history && typeof history.recordVisit === 'function') {
          history.recordVisit({ url: reportedUrl, title: entryTitle, tabId: matchingTab.id });
        }
      }
    }

    if (hasRealTitle) {
      matchingTab.title = reportedTitle;
    } else if (matchingTab.customTitle) {
      matchingTab.title = matchingTab.customTitle;
    } else if (reportedUrl) {
      matchingTab.title = getDisplayHost(reportedUrl);
    }

    if (matchingTab.history[matchingTab.historyIndex] && matchingTab.title) {
      matchingTab.history[matchingTab.historyIndex].title = matchingTab.title;
    }
    if (history && typeof history.updateTitle === 'function' && reportedUrl && hasRealTitle) {
      history.updateTitle(reportedUrl, reportedTitle);
    }

    matchingTab.loading = false;
    renderTabs();
    if (!isGamesActive && matchingTab.id === activeTabId) {
      syncToolbar();
    }
    saveTabsSession();
  });

  function resetTabs() {
    isGamesActive = false;
    tabs.forEach((t) => {
      if (t.iframe) t.iframe.remove();
    });
    tabs = [];
    activeTabId = null;
    createTab();
  }

  renderBookmarks();

  return {
    open,
    setSearchEngine,
    resetTabs,
    openUrlInNewTab,
    openGamesTab,
    getActiveTab,
    navigateActiveTab,
    jumpToTabIndex,
    goBack,
    goForward,
  };
}
