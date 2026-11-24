const PAGE_SIZE = 48;

const GAME_ICON_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="6" width="20" height="12" rx="4"/><path d="M6 12h4"/><path d="M8 10v4"/><circle cx="15.5" cy="11" r="1"/><circle cx="17.5" cy="13" r="1"/></svg>';

export function createGamesController({ onOpenGame }) {
  const gamesView = document.getElementById('games-view');
  const countReadout = document.getElementById('games-count-readout');
  const searchInput = document.getElementById('games-search-input');
  const sourceFiltersEl = document.getElementById('games-source-filters');
  const categorySelect = document.getElementById('games-category-select');
  const gamesGrid = document.getElementById('games-grid');
  const statusMsg = document.getElementById('games-status-msg');
  const loadMoreWrap = document.getElementById('games-load-more-wrap');
  const loadMoreBtn = document.getElementById('games-load-more-btn');
  const openRobloxBtn = document.getElementById('games-open-roblox');
  const openStrongdogXpBtn = document.getElementById('games-open-strongdog-xp');
  const openStrongdogClassicBtn = document.getElementById('games-open-strongdog-classic');

  let allGames = [];
  let loaded = false;
  let loading = false;
  let activeSource = 'all';
  let activeCategory = 'all';
  let searchQuery = '';
  let visibleCount = PAGE_SIZE;

  function formatSourceLabel(source) {
    if (source === 'strongdog') return 'StrongDog';
    if (source === 'now.gg') return 'now.gg';
    return 'gn-math';
  }

  function populateCategories() {
    const categories = new Set();
    allGames.forEach((game) => {
      if (activeSource === 'all' || game.source === activeSource) {
        if (game.category) categories.add(game.category);
      }
    });

    const sorted = Array.from(categories).sort((a, b) => a.localeCompare(b));
    categorySelect.innerHTML = '';

    const allOpt = document.createElement('option');
    allOpt.value = 'all';
    allOpt.textContent = 'All Categories';
    categorySelect.appendChild(allOpt);

    sorted.forEach((cat) => {
      const opt = document.createElement('option');
      opt.value = cat;
      opt.textContent = cat;
      categorySelect.appendChild(opt);
    });

    if (activeCategory !== 'all' && !categories.has(activeCategory)) {
      activeCategory = 'all';
    }
    categorySelect.value = activeCategory;
  }

  function getFilteredGames() {
    const q = searchQuery.trim().toLowerCase();
    return allGames.filter((game) => {
      if (activeSource !== 'all' && game.source !== activeSource) return false;
      if (activeCategory !== 'all' && game.category !== activeCategory) return false;
      if (q) {
        const hay = `${game.title} ${game.category} ${game.source}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  function renderGames() {
    if (!loaded && loading) {
      statusMsg.hidden = false;
      statusMsg.textContent = 'Loading game library...';
      gamesGrid.innerHTML = '';
      loadMoreWrap.hidden = true;
      return;
    }

    const filtered = getFilteredGames();
    const gnCount = filtered.filter((g) => g.source === 'gn-math').length;
    const sdCount = filtered.filter((g) => g.source === 'strongdog').length;
    const nowCount = filtered.filter((g) => g.source === 'now.gg').length;

    if (countReadout) {
      const parts = [`${filtered.length} games`, `${gnCount} gn-math`, `${sdCount} StrongDog`];
      if (nowCount > 0) parts.push(`${nowCount} now.gg`);
      countReadout.textContent = parts.join(' · ');
    }

    gamesGrid.innerHTML = '';

    if (filtered.length === 0) {
      statusMsg.hidden = false;
      statusMsg.textContent = 'No matching games found. Try clearing your search or switching sources.';
      loadMoreWrap.hidden = true;
      return;
    }

    statusMsg.hidden = true;
    const slice = filtered.slice(0, visibleCount);

    slice.forEach((game) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'game-card';

      const coverWrap = document.createElement('div');
      const sourceSlug = String(game.source || '').replace(/[^a-z0-9_-]/gi, '');
      coverWrap.className = `game-cover-wrap is-${sourceSlug}`;

      const fallback = document.createElement('div');
      fallback.className = 'game-cover-fallback';
      fallback.innerHTML = GAME_ICON_SVG;
      const fallbackTitle = document.createElement('span');
      fallbackTitle.textContent = game.title;
      fallback.appendChild(fallbackTitle);
      coverWrap.appendChild(fallback);

      if (game.cover) {
        const img = document.createElement('img');
        img.className = 'game-cover-img';
        img.src = `/api/proxy?url=${encodeURIComponent(game.cover)}`;
        img.alt = game.title;
        img.loading = 'lazy';
        img.referrerPolicy = 'no-referrer';
        img.addEventListener('error', () => {
          img.remove();
        });
        coverWrap.appendChild(img);
      }

      const body = document.createElement('div');
      body.className = 'game-card-body';

      const meta = document.createElement('div');
      meta.className = 'game-meta-line';
      const sourceSpan = document.createElement('span');
      sourceSpan.textContent = formatSourceLabel(game.source);
      const sep = document.createElement('span');
      sep.setAttribute('aria-hidden', 'true');
      sep.textContent = '·';
      const catSpan = document.createElement('span');
      catSpan.textContent = game.category || formatSourceLabel(game.source);
      meta.append(sourceSpan, sep, catSpan);

      const titleEl = document.createElement('h3');
      titleEl.className = 'game-title';
      titleEl.textContent = game.title;

      body.append(meta, titleEl);
      card.append(coverWrap, body);

      card.addEventListener('click', () => {
        if (typeof onOpenGame === 'function') {
          onOpenGame(game);
        }
      });

      gamesGrid.appendChild(card);
    });

    if (filtered.length > visibleCount) {
      loadMoreWrap.hidden = false;
      loadMoreBtn.textContent = `Load More (${filtered.length - visibleCount} remaining)`;
    } else {
      loadMoreWrap.hidden = true;
    }
  }

  async function ensureLoaded() {
    if (loaded || loading) return;
    loading = true;
    renderGames();
    try {
      const res = await fetch('/api/games');
      if (!res.ok) throw new Error('Failed to load game catalog');
      const data = await res.json();
      allGames = Array.isArray(data.games) ? data.games : [];
      loaded = true;
      populateCategories();
    } catch {
      statusMsg.hidden = false;
      statusMsg.textContent = 'Unable to load the game catalog right now. Please try reloading.';
    } finally {
      loading = false;
      if (loaded) renderGames();
    }
  }

  if (sourceFiltersEl) {
    sourceFiltersEl.addEventListener('click', (ev) => {
      const btn = ev.target.closest('button[data-source]');
      if (!btn) return;
      activeSource = btn.getAttribute('data-source') || 'all';
      sourceFiltersEl.querySelectorAll('button[data-source]').forEach((el) => {
        el.classList.toggle('is-active', el === btn);
      });
      visibleCount = PAGE_SIZE;
      populateCategories();
      renderGames();
    });
  }

  if (categorySelect) {
    categorySelect.addEventListener('change', () => {
      activeCategory = categorySelect.value || 'all';
      visibleCount = PAGE_SIZE;
      renderGames();
    });
  }

  if (searchInput) {
    searchInput.addEventListener('input', () => {
      searchQuery = searchInput.value;
      visibleCount = PAGE_SIZE;
      renderGames();
    });
  }

  if (loadMoreBtn) {
    loadMoreBtn.addEventListener('click', () => {
      visibleCount += PAGE_SIZE;
      renderGames();
    });
  }

  if (openRobloxBtn) {
    openRobloxBtn.addEventListener('click', () => {
      onOpenGame?.({ title: 'Roblox', url: 'https://now.gg/apps/a/19900/b.html?ng_ntmSource=PopularGames' });
    });
  }

  if (openStrongdogXpBtn) {
    openStrongdogXpBtn.addEventListener('click', () => {
      onOpenGame?.({ title: 'StrongDog XP', url: 'https://strongdog-xp.com/' });
    });
  }

  if (openStrongdogClassicBtn) {
    openStrongdogClassicBtn.addEventListener('click', () => {
      onOpenGame?.({ title: 'StrongDog', url: 'https://strongdog.com/' });
    });
  }

  function onActivated() {
    void ensureLoaded();
    if (gamesView && !gamesView.hidden && searchInput) {
      window.setTimeout(() => searchInput.focus(), 20);
    }
  }

  return { onActivated };
}
