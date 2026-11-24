const SESSION_HISTORY_KEY = 'yamal_session_history_v1';
const SESSION_TABS_KEY = 'yamal_session_tabs_v1';
const MAX_SESSION_ENTRIES = 250;

function readJsonStorage(key, fallback) {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJsonStorage(key, value) {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore storage quota errors
  }
}

function formatVisitTime(ts) {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function getHostnameLabel(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export function createHistoryController({
  getActiveTab,
  onNavigateInActiveTab,
  onOpenInNewTab,
  onJumpToTabIndex,
} = {}) {
  const historyMenuBtn = document.getElementById('history-menu-btn');
  const historyModal = document.getElementById('history-modal');
  const historyCloseBtn = document.getElementById('history-close-btn');
  const historySearchInput = document.getElementById('history-search-input');
  const historyClearBtn = document.getElementById('history-clear-btn');
  const historyTabTrailEl = document.getElementById('history-tab-trail');
  const historySessionListEl = document.getElementById('history-session-list');
  const historyEmptyMsg = document.getElementById('history-empty-msg');

  let entries = readJsonStorage(SESSION_HISTORY_KEY, []);
  if (!Array.isArray(entries)) entries = [];

  function saveEntries() {
    writeJsonStorage(SESSION_HISTORY_KEY, entries);
  }

  function recordVisit({ url, title, tabId } = {}) {
    if (!url || typeof url !== 'string') return;
    const cleanUrl = url.trim();
    if (!cleanUrl) return;
    const cleanTitle = (title && String(title).trim()) || getHostnameLabel(cleanUrl);
    const now = Date.now();

    const latest = entries[0];
    if (latest && latest.url === cleanUrl) {
      latest.title = cleanTitle !== cleanUrl ? cleanTitle : latest.title;
      latest.visitedAt = now;
      latest.tabId = tabId || latest.tabId;
    } else {
      entries.unshift({
        id: `h-${now}-${Math.random().toString(36).slice(2, 7)}`,
        url: cleanUrl,
        title: cleanTitle,
        visitedAt: now,
        tabId: tabId || '',
      });
      if (entries.length > MAX_SESSION_ENTRIES) {
        entries = entries.slice(0, MAX_SESSION_ENTRIES);
      }
    }

    saveEntries();
    if (historyModal && !historyModal.hidden) {
      render();
    }
  }

  function updateTitle(url, title) {
    if (!url || !title) return;
    const cleanTitle = String(title).trim();
    if (!cleanTitle || cleanTitle === url) return;
    let changed = false;
    for (let i = 0; i < Math.min(entries.length, 20); i += 1) {
      if (entries[i].url === url && entries[i].title !== cleanTitle) {
        entries[i].title = cleanTitle;
        changed = true;
      }
    }
    if (changed) {
      saveEntries();
      if (historyModal && !historyModal.hidden) {
        render();
      }
    }
  }

  function removeEntry(id) {
    entries = entries.filter((item) => item.id !== id);
    saveEntries();
    render();
  }

  function clearAll() {
    entries = [];
    saveEntries();
    render();
  }

  function saveTabsSnapshot(snapshot) {
    writeJsonStorage(SESSION_TABS_KEY, snapshot);
  }

  function loadTabsSnapshot() {
    const snap = readJsonStorage(SESSION_TABS_KEY, null);
    if (!snap || !Array.isArray(snap.tabs)) return null;
    return snap;
  }

  function closeModal() {
    if (historyModal) {
      historyModal.hidden = true;
    }
  }

  function openModal() {
    if (!historyModal) return;
    historyModal.hidden = false;
    render();
    if (historySearchInput) {
      window.setTimeout(() => historySearchInput.focus(), 20);
    }
  }

  function renderTabTrail() {
    if (!historyTabTrailEl) return;
    historyTabTrailEl.innerHTML = '';
    const activeTab = typeof getActiveTab === 'function' ? getActiveTab() : null;

    if (!activeTab || !Array.isArray(activeTab.history) || activeTab.history.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'history-trail-empty';
      empty.textContent = 'No page trail in the active tab yet.';
      historyTabTrailEl.appendChild(empty);
      return;
    }

    activeTab.history.forEach((item, idx) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      const isCurrent = idx === activeTab.historyIndex;
      btn.className = `history-trail-step${isCurrent ? ' is-current' : ''}`;

      const idxSpan = document.createElement('span');
      idxSpan.className = 'history-step-num mono-num';
      idxSpan.textContent = `${idx + 1}.`;

      const labelSpan = document.createElement('span');
      labelSpan.className = 'history-step-label';
      labelSpan.textContent = item.title || getHostnameLabel(item.url);

      const dirSpan = document.createElement('span');
      dirSpan.className = 'history-step-state';
      dirSpan.textContent = isCurrent ? 'Current' : idx < activeTab.historyIndex ? 'Back' : 'Forward';

      btn.title = item.url;
      btn.append(idxSpan, labelSpan, dirSpan);
      btn.addEventListener('click', () => {
        closeModal();
        if (typeof onJumpToTabIndex === 'function') {
          onJumpToTabIndex(idx);
        }
      });

      historyTabTrailEl.appendChild(btn);
    });
  }

  function renderSessionList() {
    if (!historySessionListEl || !historyEmptyMsg) return;
    const q = (historySearchInput ? historySearchInput.value : '').trim().toLowerCase();
    const filtered = q
      ? entries.filter(
          (item) =>
            String(item.title || '').toLowerCase().includes(q) ||
            String(item.url || '').toLowerCase().includes(q)
        )
      : entries;

    historySessionListEl.innerHTML = '';
    if (filtered.length === 0) {
      historyEmptyMsg.hidden = false;
      historyEmptyMsg.textContent = q
        ? 'No visited sites match your search.'
        : 'No sites visited in this session yet.';
      return;
    }

    historyEmptyMsg.hidden = true;
    filtered.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'history-row';

      const mainBtn = document.createElement('button');
      mainBtn.type = 'button';
      mainBtn.className = 'history-row-main';
      mainBtn.title = item.url;

      const titleEl = document.createElement('strong');
      titleEl.className = 'history-row-title';
      titleEl.textContent = item.title || getHostnameLabel(item.url);

      const metaEl = document.createElement('span');
      metaEl.className = 'history-row-meta';
      const timeStr = formatVisitTime(item.visitedAt);
      metaEl.textContent = timeStr ? `${item.url} · ${timeStr}` : item.url;

      mainBtn.append(titleEl, metaEl);
      mainBtn.addEventListener('click', () => {
        closeModal();
        if (typeof onNavigateInActiveTab === 'function') {
          onNavigateInActiveTab(item.url, item.title);
        }
      });

      const actions = document.createElement('div');
      actions.className = 'history-row-actions';

      const newTabBtn = document.createElement('button');
      newTabBtn.type = 'button';
      newTabBtn.className = 'tool-btn history-action-btn';
      newTabBtn.textContent = 'New Tab';
      newTabBtn.addEventListener('click', () => {
        closeModal();
        if (typeof onOpenInNewTab === 'function') {
          onOpenInNewTab(item.url, item.title);
        }
      });

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'tool-btn history-remove-btn';
      removeBtn.setAttribute('aria-label', `Remove ${titleEl.textContent} from history`);
      removeBtn.textContent = '×';
      removeBtn.addEventListener('click', () => removeEntry(item.id));

      actions.append(newTabBtn, removeBtn);
      row.append(mainBtn, actions);
      historySessionListEl.appendChild(row);
    });
  }

  function render() {
    renderTabTrail();
    renderSessionList();
  }

  if (historyMenuBtn) {
    historyMenuBtn.addEventListener('click', () => {
      if (historyModal && !historyModal.hidden) {
        closeModal();
      } else {
        openModal();
      }
    });
  }

  if (historyCloseBtn) {
    historyCloseBtn.addEventListener('click', closeModal);
  }

  if (historyModal) {
    historyModal.addEventListener('click', (ev) => {
      if (ev.target === historyModal) {
        closeModal();
      }
    });
  }

  if (historySearchInput) {
    historySearchInput.addEventListener('input', renderSessionList);
  }

  if (historyClearBtn) {
    historyClearBtn.addEventListener('click', clearAll);
  }

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && historyModal && !historyModal.hidden) {
      closeModal();
    }
  });

  return {
    recordVisit,
    updateTitle,
    saveTabsSnapshot,
    loadTabsSnapshot,
    openModal,
    closeModal,
  };
}
