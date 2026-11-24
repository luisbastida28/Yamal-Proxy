import { createCloakController } from './cloak.js';
import { createGamesController } from './games.js';
import { createHistoryController } from './history.js';
import { createSettingsController } from './settings.js';
import { createUnblockerController } from './unblocker.js';

try {
  localStorage.setItem('yamal_unlocked', '1');
} catch {
  // Ignore storage errors
}

const cloak = createCloakController();
let games;
let unblocker;

const history = createHistoryController({
  getActiveTab: () => (unblocker ? unblocker.getActiveTab() : null),
  onNavigateInActiveTab: (url, title) => {
    if (unblocker) unblocker.navigateActiveTab(url, title);
  },
  onOpenInNewTab: (url, title) => {
    if (unblocker) unblocker.openUrlInNewTab(url, title);
  },
  onJumpToTabIndex: (index) => {
    if (unblocker) unblocker.jumpToTabIndex(index);
  },
});

unblocker = createUnblockerController({
  onGamesTabOpen: () => games.onActivated(),
  history,
  cloak,
});

games = createGamesController({
  onOpenGame: (game) => unblocker.openUrlInNewTab(game.url, game.title, { isGame: true }),
});

createSettingsController({ cloak, unblocker });
unblocker.open();
