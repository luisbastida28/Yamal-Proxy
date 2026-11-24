const SETTINGS_STORAGE_KEY = 'yamal_settings_v1';

export const THEMES = [
  { id: 'midnight', label: 'Midnight', swatch: '#0bc2cf', bg: '#0b1120' },
  { id: 'oceanic', label: 'Oceanic', swatch: '#2dd4bf', bg: '#07192d' },
  { id: 'emerald', label: 'Emerald', swatch: '#10b981', bg: '#071a14' },
  { id: 'crimson', label: 'Crimson', swatch: '#f43f5e', bg: '#180b10' },
  { id: 'amber', label: 'Amber Gold', swatch: '#f59e0b', bg: '#14120c' },
  { id: 'daylight', label: 'Daylight', swatch: '#0284c7', bg: '#f1f5f9' },
];

function loadSettings() {
  const defaults = {
    theme: 'midnight',
    searchEngine: 'bing',
    showBookmarks: true,
    preventClose: false,
    redirectOriginal: false,
  };
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw);
    return {
      theme: typeof parsed.theme === 'string' ? parsed.theme : defaults.theme,
      searchEngine: typeof parsed.searchEngine === 'string' ? parsed.searchEngine : defaults.searchEngine,
      showBookmarks: typeof parsed.showBookmarks === 'boolean' ? parsed.showBookmarks : defaults.showBookmarks,
      preventClose: typeof parsed.preventClose === 'boolean' ? parsed.preventClose : defaults.preventClose,
      redirectOriginal:
        typeof parsed.redirectOriginal === 'boolean' ? parsed.redirectOriginal : defaults.redirectOriginal,
    };
  } catch {
    return defaults;
  }
}

export function createSettingsController({ cloak, unblocker }) {
  const unblockerShell = document.getElementById('unblocker-app');
  const settingsBtn = document.getElementById('settings-menu-btn');
  const settingsModal = document.getElementById('settings-modal');
  const settingsCloseBtn = document.getElementById('settings-close-btn');
  const themesGrid = document.getElementById('settings-themes-grid');
  const openAboutBlankBtn = document.getElementById('settings-about-blank-btn');
  const redirectOriginalCheckbox = document.getElementById('settings-redirect-original');
  const aboutBlankStatus = document.getElementById('settings-about-blank-status');
  const searchEngineSelect = document.getElementById('settings-search-engine');
  const showBookmarksCheckbox = document.getElementById('settings-show-bookmarks');
  const preventCloseCheckbox = document.getElementById('settings-prevent-close');
  const resetAllBtn = document.getElementById('settings-reset-btn');
  const bookmarksSection = document.querySelector('.bookmarks-section');

  let settings = loadSettings();

  function saveSettings() {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  }

  function applySettings() {
    unblockerShell.setAttribute('data-theme', settings.theme);
    unblocker.setSearchEngine(settings.searchEngine);
    if (bookmarksSection) {
      bookmarksSection.hidden = !settings.showBookmarks;
    }
  }

  function renderThemes() {
    themesGrid.innerHTML = '';
    THEMES.forEach((theme) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `theme-swatch-btn${settings.theme === theme.id ? ' is-selected' : ''}`;

      const dot = document.createElement('span');
      dot.className = 'theme-swatch-preview';
      dot.style.background = `linear-gradient(135deg, ${theme.bg} 55%, ${theme.swatch} 55%)`;

      const label = document.createElement('span');
      label.className = 'theme-swatch-label';
      label.textContent = theme.label;

      btn.append(dot, label);
      btn.addEventListener('click', () => {
        settings.theme = theme.id;
        saveSettings();
        applySettings();
        renderThemes();
      });

      themesGrid.appendChild(btn);
    });
  }

  function openModal() {
    settingsModal.hidden = false;
    aboutBlankStatus.textContent = '';
    searchEngineSelect.value = settings.searchEngine;
    showBookmarksCheckbox.checked = settings.showBookmarks;
    preventCloseCheckbox.checked = settings.preventClose;
    redirectOriginalCheckbox.checked = settings.redirectOriginal;
    renderThemes();
  }

  function closeModal() {
    settingsModal.hidden = true;
  }

  function launchInAboutBlank() {
    aboutBlankStatus.textContent = '';
    const win = window.open('about:blank', '_blank');
    if (!win) {
      aboutBlankStatus.textContent =
        'Popup blocked by the browser. Allow popups for this site or use Tab Cloak & Panic Key instead.';
      return;
    }

    const { title, iconUri } = cloak.getActiveCloakInfo();
    const doc = win.document;
    doc.open();
    doc.write(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${title.replace(/[<>&"]/g, '')}</title>
  <link rel="icon" type="image/svg+xml" href="${iconUri}" />
  <style>
    html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: #0b1120; }
    iframe { width: 100%; height: 100%; border: 0; display: block; }
  </style>
</head>
<body>
  <iframe src="${window.location.href}" allowfullscreen></iframe>
</body>
</html>`);
    doc.close();

    aboutBlankStatus.textContent = 'Opened Yamal in an about:blank tab.';

    if (settings.redirectOriginal) {
      window.location.replace('https://classroom.google.com');
    }
  }

  settingsBtn.addEventListener('click', () => {
    if (settingsModal.hidden) {
      openModal();
    } else {
      closeModal();
    }
  });

  settingsCloseBtn.addEventListener('click', closeModal);

  settingsModal.addEventListener('click', (ev) => {
    if (ev.target === settingsModal) {
      closeModal();
    }
  });

  openAboutBlankBtn.addEventListener('click', launchInAboutBlank);

  redirectOriginalCheckbox.addEventListener('change', () => {
    settings.redirectOriginal = redirectOriginalCheckbox.checked;
    saveSettings();
  });

  searchEngineSelect.addEventListener('change', () => {
    settings.searchEngine = searchEngineSelect.value;
    saveSettings();
    applySettings();
  });

  showBookmarksCheckbox.addEventListener('change', () => {
    settings.showBookmarks = showBookmarksCheckbox.checked;
    saveSettings();
    applySettings();
  });

  preventCloseCheckbox.addEventListener('change', () => {
    settings.preventClose = preventCloseCheckbox.checked;
    saveSettings();
  });

  resetAllBtn.addEventListener('click', () => {
    settings = {
      theme: 'midnight',
      searchEngine: 'bing',
      showBookmarks: true,
      preventClose: false,
      redirectOriginal: false,
    };
    saveSettings();
    cloak.resetCloak();
    unblocker.resetTabs();
    applySettings();
    openModal();
    aboutBlankStatus.textContent = 'All Yamal settings and tabs have been reset.';
  });

  window.addEventListener('beforeunload', (ev) => {
    if (settings.preventClose) {
      ev.preventDefault();
      ev.returnValue = '';
    }
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !settingsModal.hidden) {
      closeModal();
    }
  });

  applySettings();
}
