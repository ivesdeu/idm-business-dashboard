let deferredInstallPrompt = null;

function showInstallButton() {
  const existing = document.getElementById('settings-install-app-btn');
  if (existing) return existing;

  const panel = document.getElementById('settings-panel-general');
  if (!panel) return null;
  const stack = panel.querySelector('.settings-stack');
  if (!stack) return null;

  const card = document.createElement('div');
  card.className = 'card';
  card.id = 'settings-install-app-card';
  card.innerHTML = [
    '<div class="fst">Install app</div>',
    '<p class="settings-pref-desc" style="margin: 10px 0 12px;">Install Business Dashboard as a desktop app for quicker launch and a dedicated window.</p>',
    '<button type="button" class="btn" id="settings-install-app-btn">Install app</button>',
  ].join('');

  stack.insertBefore(card, stack.firstChild);
  return card.querySelector('#settings-install-app-btn');
}

async function triggerInstall() {
  if (!deferredInstallPrompt) return;
  const promptEvent = deferredInstallPrompt;
  deferredInstallPrompt = null;
  try {
    await promptEvent.prompt();
    await promptEvent.userChoice;
  } catch (_) {}
}

export function wirePwaInstallUi() {
  if (typeof window === 'undefined') return;

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    const button = showInstallButton();
    if (!button) return;
    button.style.display = '';
    button.disabled = false;
  });

  const mounted = window.setInterval(() => {
    const button = document.getElementById('settings-install-app-btn');
    if (!button) return;
    button.addEventListener('click', () => {
      void triggerInstall();
    });
    window.clearInterval(mounted);
  }, 500);
}

