const CLOAK_STORAGE_KEY = 'yamal_cloak_settings_v1';

function svgToDataUri(svg) {
  return `data:image/svg+xml,${encodeURIComponent(svg.trim())}`;
}

export const CLOAK_PRESETS = [
  {
    id: 'default',
    label: 'Yamal (Default)',
    title: 'Yamal',
    iconSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#0f172a"/><path d="M9 9l7 9v6m7-15l-7 9" stroke="#0bc2cf" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>`,
  },
  {
    id: 'classroom',
    label: 'Google Classroom',
    title: 'Home - Classroom',
    iconSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="4" fill="#fbbc04"/><rect x="3" y="4" width="26" height="22" rx="2" fill="#1e8e3e"/><circle cx="16" cy="13" r="3.2" fill="#ffffff"/><path d="M10.5 21.5c0-2.8 2.5-4.5 5.5-4.5s5.5 1.7 5.5 4.5" fill="#ffffff"/></svg>`,
  },
  {
    id: 'classlink',
    label: 'ClassLink',
    title: 'Login - ClassLink',
    iconSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#0284c7"/><path d="M10.5 22h11a4.5 4.5 0 0 0 .8-8.9A6 6 0 0 0 10.6 11a4.8 4.8 0 0 0-.1 11z" fill="#ffffff"/></svg>`,
  },
  {
    id: 'schoology',
    label: 'Schoology',
    title: 'Home | Schoology',
    iconSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="15" fill="#0677ba"/><text x="16" y="22.5" text-anchor="middle" font-family="Arial,sans-serif" font-weight="bold" font-size="20" fill="#ffffff">S</text></svg>`,
  },
  {
    id: 'canvas',
    label: 'Canvas LMS',
    title: 'Dashboard',
    iconSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#e13f2b"/><circle cx="16" cy="16" r="5" fill="#ffffff"/><circle cx="16" cy="6" r="2.2" fill="#ffffff"/><circle cx="16" cy="26" r="2.2" fill="#ffffff"/><circle cx="6" cy="16" r="2.2" fill="#ffffff"/><circle cx="26" cy="16" r="2.2" fill="#ffffff"/></svg>`,
  },
  {
    id: 'docs',
    label: 'Google Docs',
    title: 'Untitled document - Google Docs',
    iconSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path d="M7 3h12l7 7v19a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" fill="#4285f4"/><path d="M19 3v7h7" fill="#a1c2fa"/><path d="M10 15h12M10 19h12M10 23h8" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round"/></svg>`,
  },
  {
    id: 'drive',
    label: 'Google Drive',
    title: 'My Drive - Google Drive',
    iconSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><polygon points="11,5 21,5 29,19 19,19" fill="#fbbc04"/><polygon points="3,19 11,5 16,14 8,28" fill="#0f9d58"/><polygon points="8,28 13,19 29,19 24,28" fill="#4285f4"/></svg>`,
  },
  {
    id: 'khan',
    label: 'Khan Academy',
    title: 'Dashboard | Khan Academy',
    iconSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><polygon points="16,2 29,9.5 29,22.5 16,30 3,22.5 3,9.5" fill="#14bf96"/><circle cx="16" cy="12" r="3" fill="#ffffff"/><path d="M10 20c2-3 4-4 6-4s4 1 6 4c-2 2.5-4 3.5-6 3.5s-4-1-6-3.5z" fill="#ffffff"/></svg>`,
  },
  {
    id: 'clever',
    label: 'Clever',
    title: 'Clever | Portal',
    iconSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#2563eb"/><text x="16" y="22.5" text-anchor="middle" font-family="Arial,sans-serif" font-weight="bold" font-size="20" fill="#ffffff">C</text></svg>`,
  },
];

function loadCloakSettings() {
  const defaults = {
    presetId: 'default',
    customTitle: '',
    panicKey: 'Backquote',
    panicTarget: 'classroom',
  };
  try {
    const raw = localStorage.getItem(CLOAK_STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw);
    return {
      presetId: typeof parsed.presetId === 'string' ? parsed.presetId : defaults.presetId,
      customTitle: typeof parsed.customTitle === 'string' ? parsed.customTitle : defaults.customTitle,
      panicKey: typeof parsed.panicKey === 'string' ? parsed.panicKey : defaults.panicKey,
      panicTarget: typeof parsed.panicTarget === 'string' ? parsed.panicTarget : defaults.panicTarget,
    };
  } catch {
    return defaults;
  }
}

function setDocumentFavicon(dataUri) {
  let iconLinks = document.querySelectorAll('link[rel*="icon"]');
  if (iconLinks.length === 0) {
    const link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
    iconLinks = document.querySelectorAll('link[rel*="icon"]');
  }
  iconLinks.forEach((link) => {
    link.setAttribute('type', 'image/svg+xml');
    link.setAttribute('href', dataUri);
  });
}

function buildDecoyMarkup(targetId) {
  if (targetId === 'classlink') {
    return `
      <div class="decoy-page decoy-classlink">
        <header class="decoy-header decoy-classlink-bar">
          <div class="decoy-brand">ClassLink LaunchPad</div>
          <div class="decoy-user">Student Portal</div>
        </header>
        <main class="decoy-main">
          <h2 class="decoy-heading">My Apps</h2>
          <div class="decoy-apps-grid">
            <div class="decoy-app-tile"><span class="decoy-app-box" style="background:#1e8e3e">GC</span><span>Google Classroom</span></div>
            <div class="decoy-app-tile"><span class="decoy-app-box" style="background:#4285f4">GD</span><span>Google Drive</span></div>
            <div class="decoy-app-tile"><span class="decoy-app-box" style="background:#0677ba">S</span><span>Schoology</span></div>
            <div class="decoy-app-tile"><span class="decoy-app-box" style="background:#14bf96">KA</span><span>Khan Academy</span></div>
            <div class="decoy-app-tile"><span class="decoy-app-box" style="background:#e13f2b">CV</span><span>Canvas</span></div>
            <div class="decoy-app-tile"><span class="decoy-app-box" style="background:#0284c7">IX</span><span>IXL Learning</span></div>
          </div>
        </main>
      </div>
    `;
  }

  if (targetId === 'docs') {
    return `
      <div class="decoy-page decoy-docs">
        <header class="decoy-header decoy-docs-bar">
          <div class="decoy-brand">Untitled document</div>
          <div class="decoy-user">Saved to Drive</div>
        </header>
        <main class="decoy-doc-sheet">
          <h1>Unit 4 Reading Notes</h1>
          <p>Key concepts from Chapter 7 cover the relationship between atmospheric pressure, ocean currents, and seasonal temperature shifts across coastal regions.</p>
          <p>1. Thermal energy distribution occurs primarily through convection and surface wind patterns.</p>
          <p>2. Coastal climates experience narrower temperature ranges due to water's high specific heat capacity.</p>
        </main>
      </div>
    `;
  }

  return `
    <div class="decoy-page decoy-classroom">
      <header class="decoy-header decoy-classroom-bar">
        <div class="decoy-brand">Google Classroom</div>
        <div class="decoy-user">Classes · To-do</div>
      </header>
      <main class="decoy-main">
        <h2 class="decoy-heading">Enrolled Classes</h2>
        <div class="decoy-classes-grid">
          <div class="decoy-class-card">
            <div class="decoy-class-banner" style="background:#1e8e3e"><strong>Biology 101</strong><span>Period 2</span></div>
            <div class="decoy-class-body">Due Friday: Lab Worksheet #4</div>
          </div>
          <div class="decoy-class-card">
            <div class="decoy-class-banner" style="background:#1967d2"><strong>Algebra II</strong><span>Period 3</span></div>
            <div class="decoy-class-body">Due Tomorrow: Practice Set 6.2</div>
          </div>
          <div class="decoy-class-card">
            <div class="decoy-class-banner" style="background:#8430ce"><strong>World History</strong><span>Period 5</span></div>
            <div class="decoy-class-body">Reading: Chapter 12 Summary</div>
          </div>
        </div>
      </main>
    </div>
  `;
}

export function createCloakController() {
  const cloakBtn = document.getElementById('cloak-menu-btn');
  const cloakModal = document.getElementById('cloak-modal');
  const cloakCloseBtn = document.getElementById('cloak-close-btn');
  const presetsGrid = document.getElementById('cloak-presets-grid');
  const customForm = document.getElementById('cloak-custom-form');
  const customTitleInput = document.getElementById('cloak-custom-title');
  const panicKeySelect = document.getElementById('cloak-panic-key');
  const panicTargetSelect = document.getElementById('cloak-panic-target');
  const testPanicBtn = document.getElementById('cloak-test-panic-btn');
  const panicOverlay = document.getElementById('panic-overlay');

  let settings = loadCloakSettings();
  let panicActive = false;

  function saveSettings() {
    localStorage.setItem(CLOAK_STORAGE_KEY, JSON.stringify(settings));
  }

  function applyCloakVisuals(overridePresetId = null) {
    const targetId = overridePresetId || settings.presetId;
    const preset = CLOAK_PRESETS.find((p) => p.id === targetId) || CLOAK_PRESETS[0];
    const resolvedTitle =
      !overridePresetId && settings.customTitle.trim() ? settings.customTitle.trim() : preset.title;

    document.title = resolvedTitle;
    setDocumentFavicon(svgToDataUri(preset.iconSvg));
  }

  function renderPresets() {
    presetsGrid.innerHTML = '';
    CLOAK_PRESETS.forEach((preset) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `cloak-preset-btn${
        settings.presetId === preset.id && !settings.customTitle ? ' is-selected' : ''
      }`;

      const iconWrap = document.createElement('span');
      iconWrap.className = 'cloak-preset-icon';
      iconWrap.innerHTML = preset.iconSvg;

      const textWrap = document.createElement('span');
      textWrap.className = 'cloak-preset-text';

      const nameEl = document.createElement('strong');
      nameEl.textContent = preset.label;

      const titleEl = document.createElement('small');
      titleEl.textContent = preset.title;

      textWrap.append(nameEl, titleEl);
      btn.append(iconWrap, textWrap);

      btn.addEventListener('click', () => {
        settings.presetId = preset.id;
        settings.customTitle = '';
        customTitleInput.value = '';
        saveSettings();
        applyCloakVisuals();
        renderPresets();
      });

      presetsGrid.appendChild(btn);
    });
  }

  function openModal() {
    cloakModal.hidden = false;
    customTitleInput.value = settings.customTitle;
    panicKeySelect.value = settings.panicKey;
    panicTargetSelect.value = settings.panicTarget;
    renderPresets();
  }

  function closeModal() {
    cloakModal.hidden = true;
  }

  function togglePanic(forceState) {
    panicActive = typeof forceState === 'boolean' ? forceState : !panicActive;
    if (panicActive) {
      closeModal();
      panicOverlay.innerHTML = buildDecoyMarkup(settings.panicTarget);
      panicOverlay.hidden = false;
      applyCloakVisuals(settings.panicTarget);
      const decoyHeader = panicOverlay.querySelector('.decoy-header');
      if (decoyHeader) {
        decoyHeader.addEventListener('dblclick', () => togglePanic(false));
      }
    } else {
      panicOverlay.hidden = true;
      panicOverlay.innerHTML = '';
      applyCloakVisuals();
    }
  }

  cloakBtn.addEventListener('click', () => {
    if (cloakModal.hidden) {
      openModal();
    } else {
      closeModal();
    }
  });

  cloakCloseBtn.addEventListener('click', closeModal);

  cloakModal.addEventListener('click', (ev) => {
    if (ev.target === cloakModal) {
      closeModal();
    }
  });

  customForm.addEventListener('submit', (ev) => {
    ev.preventDefault();
    settings.customTitle = customTitleInput.value.trim();
    saveSettings();
    applyCloakVisuals();
    renderPresets();
  });

  panicKeySelect.addEventListener('change', () => {
    settings.panicKey = panicKeySelect.value;
    saveSettings();
  });

  panicTargetSelect.addEventListener('change', () => {
    settings.panicTarget = panicTargetSelect.value;
    saveSettings();
  });

  testPanicBtn.addEventListener('click', () => {
    togglePanic(true);
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !cloakModal.hidden) {
      closeModal();
      return;
    }

    if (settings.panicKey && settings.panicKey !== 'none' && ev.code === settings.panicKey) {
      const tag = document.activeElement ? document.activeElement.tagName : '';
      const isTyping = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      if (!isTyping || panicActive) {
        ev.preventDefault();
        togglePanic();
      }
    }
  });

  applyCloakVisuals();

  return {
    getActiveCloakInfo: () => {
      const preset = CLOAK_PRESETS.find((p) => p.id === settings.presetId) || CLOAK_PRESETS[0];
      const title = settings.customTitle.trim() || preset.title;
      return {
        title,
        iconUri: svgToDataUri(preset.iconSvg),
      };
    },
    resetCloak: () => {
      settings = {
        presetId: 'default',
        customTitle: '',
        panicKey: 'Backquote',
        panicTarget: 'classroom',
      };
      saveSettings();
      applyCloakVisuals();
      if (!cloakModal.hidden) {
        openModal();
      }
    },
  };
}
