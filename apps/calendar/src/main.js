import '../../../packages/design-system/terminal.css';

import { addDaysIso } from './domain/date-time.js';
import { createAppStore } from './state/app-store.js';
import { parseUrlBootstrap } from './state/sync-reducer.js';
import {
  renderAgendaView,
  renderMonthView
} from './ui/agenda-month-view.js';
import {
  buildAgentDialogHtml,
  buildEventDialogHtml,
  buildTodoDialogHtml
} from './ui/dialogs.js';
import {
  handleDialogClick,
  handleDialogSubmit,
  syncEventEndOnStartEdit,
  updateFormDialogDom
} from './ui/dialog-handlers.js';
import {
  handleComposerInput,
  handleContentClick,
  handleContentSubmit,
  runSafely,
  stepMonthView
} from './ui/dom-handlers.js';
import {
  attachMobileUx,
  captureActiveInputFocus,
  restoreActiveInputFocus
} from './ui/mobile-ux.js';
import { renderSettingsView } from './ui/settings-view.js';
import { renderTodoView } from './ui/todo-view.js';
import {
  PAGE_META,
  buildTtyBarHtml,
  syncBottomNavDom,
  syncUnderlayDom
} from './ui/underlay.js';

const KEY_PAGE_MAP = Object.freeze({
  d: 'agenda',
  m: 'month',
  t: 'todo',
  c: 'settings'
});

const DIALOG_FOCUS_SELECTOR = Object.freeze({
  event: '#ev-title',
  todo: '#td-text',
  agent: '#ag-id'
});

function renderActivePageHtml(state, ui) {
  if (state.page === 'month') {
    return renderMonthView(state);
  }
  if (state.page === 'todo') {
    return renderTodoView(state, ui.composer);
  }
  if (state.page === 'settings') {
    return renderSettingsView(state, ui.prefs);
  }
  return renderAgendaView(state);
}

function syncShellChrome(ui, state) {
  const [title, sub, cta] = PAGE_META[state.page] || PAGE_META.agenda;
  ui.doc.body.dataset.theme = state.theme;
  const themeMeta = ui.doc.querySelector('#theme-color-meta');
  if (themeMeta) {
    const hex = state.theme === 'black' ? '#171614' : '#f6f2e9';
    themeMeta.setAttribute('content', hex);
  }
  if (state.motionOff) {
    ui.doc.body.dataset.motion = 'off';
  } else {
    delete ui.doc.body.dataset.motion;
  }
  ui.doc.querySelector('#page-title').textContent = title;
  ui.doc.querySelector('#page-sub').textContent = sub;
  const tty = buildTtyBarHtml(state);
  if (ui.chromeCache.path !== tty.pathHtml) {
    ui.chromeCache.path = tty.pathHtml;
    ui.doc.querySelector('#tty-path').innerHTML = tty.pathHtml;
  }
  if (ui.chromeCache.stat !== tty.statHtml) {
    ui.chromeCache.stat = tty.statHtml;
    ui.doc.querySelector('#tty-stat').innerHTML = tty.statHtml;
  }
  syncUnderlayDom(ui.doc, ui.chromeCache, state);
  ui.doc.querySelector('#settings-button').hidden = state.page === 'settings';
  ui.doc.querySelector('#back-button').hidden = state.page !== 'settings';
  const createBtn = ui.doc.querySelector('#create-button');
  createBtn.hidden = !cta;
  if (cta) {
    createBtn.textContent = cta;
  }
  syncBottomNavDom(ui.doc, ui.chromeCache, state.page);
}

function renderContentPane(ui, animateClass) {
  const anim = animateClass || ui.pendingAnim || '';
  ui.pendingAnim = '';
  const state = ui.store.getState();
  syncShellChrome(ui, state);
  const content = ui.doc.querySelector('#content');
  const focusSnap = captureActiveInputFocus(ui.doc, content);
  content.innerHTML = renderActivePageHtml(state, ui);
  restoreActiveInputFocus(ui.doc, focusSnap);
  if (anim) {
    content.classList.remove(anim);
    void content.offsetWidth;
    content.classList.add(anim);
  }
}

function navigateToPage(ui, page, navOpts) {
  if (page === ui.store.getState().page) {
    return;
  }
  if (typeof window !== 'undefined' && window.history) {
    if (navOpts?.replaceHistory) {
      window.history.replaceState?.({ page }, '', `?page=${page}`);
    } else {
      window.history.pushState?.({ page }, '', `?page=${page}`);
    }
  }
  ui.pendingAnim = 'view-enter';
  ui.store.setViewState({ page });
  if (page === 'settings') {
    ui.store.refreshAdminSnapshot?.().catch(() => null);
  }
}

function openDialogWith(ui, kind, title, html) {
  const dialog = ui.doc.querySelector('#form-dialog');
  const form = ui.doc.querySelector('#active-form');
  form.dataset.kind = kind;
  ui.doc.querySelector('#dialog-title').textContent = title;
  form.innerHTML = html;
  updateFormDialogDom(form, ui.store.getState().todayIso);
  if (typeof dialog.showModal === 'function') {
    dialog.showModal();
  } else {
    dialog.setAttribute('open', '');
  }
  const focusSel = DIALOG_FOCUS_SELECTOR[kind];
  const target = focusSel ? form.querySelector(focusSel) : null;
  if (target && !target.disabled && !target.readOnly) {
    target.focus?.();
  }
}

function openModalByKind(ui, kind, editId) {
  const state = ui.store.getState();
  ui.editingId = editId || null;
  if (kind === 'todo') {
    const title = editId ? '编辑 Todo 与唤醒对象' : '新建 Todo';
    openDialogWith(ui, 'todo', title, buildTodoDialogHtml(state, editId));
    return;
  }
  if (kind === 'agent') {
    const title = editId ? '编辑外部 Agent' : '绑定外部 Agent';
    openDialogWith(ui, 'agent', title, buildAgentDialogHtml(state, editId));
    return;
  }
  const title = editId ? '编辑日程' : '新建日程';
  openDialogWith(ui, 'event', title, buildEventDialogHtml(state, editId));
}

function bindTopChromeListeners(ui) {
  const doc = ui.doc;
  const store = ui.store;
  doc.querySelector('#bottom-nav').addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-page]');
    if (btn) {
      navigateToPage(ui, btn.dataset.page);
    }
  });
  doc.querySelector('#settings-button').addEventListener('click', () => {
    navigateToPage(ui, 'settings');
  });
  doc.querySelector('#back-button').addEventListener('click', () => {
    navigateToPage(ui, store.getState().lastMainPage);
  });
  doc.querySelector('#theme-toggle').addEventListener('click', () => {
    const next = store.getState().theme === 'black' ? 'white' : 'black';
    store.setTheme(next);
  });
  doc.querySelector('#create-button').addEventListener('click', () => {
    const kind = store.getState().page === 'todo' ? 'todo' : 'event';
    openModalByKind(ui, kind, null);
  });
  doc.querySelector('#dialog-close').addEventListener('click', () => {
    doc.querySelector('#form-dialog').close();
  });
}

function hasShortcutModifier(event) {
  return Boolean(
    event.metaKey || event.ctrlKey || event.altKey || event.isComposing
  );
}

function bindGlobalShortcuts(ui) {
  const dialog = ui.doc.querySelector('#form-dialog');
  const createBtn = ui.doc.querySelector('#create-button');
  ui.doc.addEventListener('keydown', (event) => {
    const fieldSel = 'input, select, textarea, [contenteditable]';
    if (hasShortcutModifier(event) ||
        event.target.closest?.(fieldSel) ||
        dialog.open) {
      return;
    }
    const key = event.key.toLowerCase();
    if (KEY_PAGE_MAP[key]) {
      event.preventDefault();
      navigateToPage(ui, KEY_PAGE_MAP[key]);
      return;
    }
    if (key === 'n' && !createBtn.hidden) {
      event.preventDefault();
      createBtn.click();
      return;
    }
    if (key === 'b') {
      event.preventDefault();
      ui.doc.querySelector('#theme-toggle').click();
    }
  });
}

function createInitialChromeCache() {
  return {
    path: '',
    stat: '',
    navPage: '',
    uPage: '',
    uDate: '',
    uPool: null,
    uTodos: null
  };
}

function bindPaneAndFormEvents(ui) {
  const doc = ui.doc;
  const store = ui.store;
  const content = doc.querySelector('#content');
  content.addEventListener('input', (ev) => handleComposerInput(ui, ev));
  content.addEventListener('change', (ev) => handleComposerInput(ui, ev));
  content.addEventListener('submit', (ev) => handleContentSubmit(ui, ev));
  content.addEventListener('click', (ev) => handleContentClick(ui, ev));
  const form = doc.querySelector('#active-form');
  const syncDom = (ev) => {
    syncEventEndOnStartEdit(form, ev);
    updateFormDialogDom(form, store.getState().todayIso);
  };
  form.addEventListener('input', syncDom);
  form.addEventListener('change', syncDom);
  form.addEventListener('click', (ev) => handleDialogClick(ui, ev));
  form.addEventListener('submit', (ev) => handleDialogSubmit(ui, ev));
  doc.querySelector('#toast')?.addEventListener('click', (ev) => {
    const undoBtn = ev.target.closest?.('[data-toast-undo]');
    if (undoBtn && ui.undoAction) {
      const fn = ui.undoAction;
      ui.undoAction = null;
      const toastEl = doc.querySelector('#toast');
      toastEl?.classList.remove('show', 'interactive');
      runSafely(ui, fn(), '已恢复', { trigger: undoBtn });
    }
  });
}

export function createCalendarApp(doc, store) {
  const initState = store.getState();
  const preferClaim = Boolean(initState.isNativeAndroid) ||
    (initState.isLocalDevice && initState.mode === 'cloud');
  const ui = {
    doc,
    store,
    editingId: null,
    toastTimer: null,
    undoAction: null,
    pendingAnim: '',
    chromeCache: createInitialChromeCache(),
    prefs: { authTab: preferClaim ? 'claim' : 'login' },
    composer: {
      target: '@me',
      time: '07:30',
      schedule: '工作日',
      date: addDaysIso(initState.todayIso, 1),
      weeklyDow: 5,
      text: ''
    },
    render: null,
    openModal: null,
    destroy: null
  };
  ui.render = () => renderContentPane(ui, '');
  ui.openModal = (kind, id) => openModalByKind(ui, kind, id);
  const unsubStore = store.subscribe(() => renderContentPane(ui, ''));
  bindTopChromeListeners(ui);
  bindPaneAndFormEvents(ui);
  bindGlobalShortcuts(ui);
  const detachMobile = attachMobileUx(ui, {
    onNavigate: (page) => navigateToPage(ui, page, { replaceHistory: true }),
    onMonthDelta: (delta) => stepMonthView(ui, delta)
  });
  ui.destroy = () => {
    clearTimeout(ui.toastTimer);
    unsubStore();
    detachMobile();
  };
  renderContentPane(ui, '');
  return ui;
}

function bootBrowserApp() {
  if (typeof document === 'undefined' || !document.querySelector('#content')) {
    return;
  }
  const hasWin = typeof window !== 'undefined';
  const rawSearch = hasWin ? window.location.search : '';
  const boot = parseUrlBootstrap(rawSearch);
  const store = createAppStore({
    storage: typeof localStorage !== 'undefined' ? localStorage : null,
    initialQuery: rawSearch
  });
  const app = createCalendarApp(document, store);
  if (hasWin) {
    window.addEventListener('popstate', (ev) => {
      store.setViewState({ page: ev.state?.page || 'agenda' });
    });
    if (!boot.cloudUrl && !boot.token) {
      window.history.replaceState(
        { page: boot.page }, '', `?page=${boot.page}`
      );
    }
  }
  if (boot.createKind) {
    const kind = boot.createKind === 'todo' ? 'todo' : 'event';
    openModalByKind(app, kind, null);
  }
}

bootBrowserApp();
