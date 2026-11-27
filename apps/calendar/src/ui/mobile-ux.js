import { escapeHtml } from '../domain/date-time.js';

const SWIPE_MIN_PX = 54;
const SWIPE_RATIO = 1.8;

export function showToast(ui, message) {
  const el = ui.doc.querySelector('#toast');
  if (!el) {
    return;
  }
  ui.undoAction = null;
  el.classList.remove('interactive');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(ui.toastTimer);
  ui.toastTimer = setTimeout(() => {
    el.classList.remove('show');
  }, 2200);
}

export function showUndoToast(ui, message, onUndo) {
  const el = ui.doc.querySelector('#toast');
  if (!el) {
    return;
  }
  ui.undoAction = onUndo;
  el.classList.add('interactive', 'show');
  el.innerHTML = `<span>${escapeHtml(message)}</span>` +
    '<button class="toast-undo" type="button" data-toast-undo>撤销</button>';
  clearTimeout(ui.toastTimer);
  ui.toastTimer = setTimeout(() => {
    ui.undoAction = null;
    el.classList.remove('show', 'interactive');
  }, 4500);
}

export function toggleSecretInput(container, btn) {
  const id = btn.dataset.toggleSecret;
  const input = container?.querySelector(`#${id}`);
  if (!input) {
    return;
  }
  const reveal = input.type === 'password';
  input.type = reveal ? 'text' : 'password';
  btn.textContent = reveal ? '隐藏' : '显示';
}

function setElementBusy(el, busy) {
  if (!el) {
    return;
  }
  if (busy) {
    el.setAttribute?.('aria-busy', 'true');
    el.disabled = true;
    return;
  }
  el.removeAttribute?.('aria-busy');
  el.disabled = false;
}

export function runSafely(ui, promise, okMessage, opts) {
  const onOk = typeof opts === 'function' ? opts : opts?.onOk;
  const triggerEl = typeof opts === 'object' ? opts?.trigger : null;
  if (triggerEl?.getAttribute?.('aria-busy') === 'true') {
    return Promise.resolve(null);
  }
  setElementBusy(triggerEl, true);
  return Promise.resolve(promise)
    .then((res) => {
      onOk?.(res);
      if (okMessage) {
        showToast(ui, okMessage);
      }
      return res;
    })
    .catch((err) => {
      showToast(ui, err?.message || '操作失败');
      return null;
    })
    .finally(() => {
      setElementBusy(triggerEl, false);
    });
}

export function captureActiveInputFocus(doc, content) {
  const active = doc.activeElement;
  if (!active || !active.id || !content.contains(active)) {
    return null;
  }
  const tag = active.tagName?.toLowerCase();
  if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') {
    return null;
  }
  return {
    id: active.id,
    value: active.value,
    start: active.selectionStart ?? null,
    end: active.selectionEnd ?? null
  };
}

export function restoreActiveInputFocus(doc, snap) {
  if (!snap) {
    return;
  }
  const next = doc.getElementById?.(snap.id) ||
    doc.querySelector(`#${snap.id}`);
  if (!next) {
    return;
  }
  if (snap.id !== 'quick-todo-input' && typeof snap.value === 'string') {
    next.value = snap.value;
  }
  next.focus?.();
  if (snap.start !== null && typeof next.setSelectionRange === 'function') {
    next.setSelectionRange(snap.start, snap.end ?? snap.start);
  }
}

export function handleAppBack(ui, onNavigate) {
  const dialog = ui.doc.querySelector('#form-dialog');
  const isOpen = Boolean(dialog?.open || dialog?.hasAttribute?.('open'));
  if (isOpen) {
    dialog.close?.();
    dialog.removeAttribute?.('open');
    return true;
  }
  const st = ui.store.getState();
  if (st.page === 'settings') {
    onNavigate(st.lastMainPage || 'agenda');
    return true;
  }
  if (st.page !== 'agenda') {
    onNavigate('agenda');
    return true;
  }
  return false;
}

function isInteractiveSwipeOrigin(target) {
  if (!target || typeof target.closest !== 'function') {
    return false;
  }
  return Boolean(target.closest('input, select, textarea, [contenteditable]'));
}

function bindMonthSwipeGesture(ui, content, onMonthDelta) {
  let start = null;
  content.addEventListener('touchstart', (ev) => {
    const touch = ev.touches?.[0];
    if (!touch || isInteractiveSwipeOrigin(ev.target) ||
        !ev.target.closest?.('.cal-card')) {
      start = null;
      return;
    }
    start = { x: touch.clientX, y: touch.clientY };
  }, { passive: true });
  content.addEventListener('touchend', (ev) => {
    const touch = ev.changedTouches?.[0];
    if (!start || !touch || ui.store.getState().page !== 'month') {
      start = null;
      return;
    }
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    start = null;
    const validHoriz = Math.abs(dx) >= SWIPE_MIN_PX &&
      Math.abs(dx) > Math.abs(dy) * SWIPE_RATIO;
    if (validHoriz) {
      onMonthDelta(dx < 0 ? 1 : -1);
    }
  }, { passive: true });
}

function resetDialogDrag(dialog, springBack) {
  if (!dialog.style) {
    return;
  }
  if (!springBack) {
    dialog.style.transition = '';
    dialog.style.transform = '';
    return;
  }
  dialog.style.transition = 'transform 200ms var(--ease)';
  dialog.style.transform = 'translateY(0)';
  setTimeout(() => {
    dialog.style.transition = '';
    dialog.style.transform = '';
  }, 210);
}

function createDialogDragController(dialog) {
  let drag = null;
  const onStart = (ev) => {
    const t = ev.touches?.[0];
    const inHead = Boolean(ev.target?.closest?.('.dialog-head'));
    drag = t && inHead ? { x: t.clientX, y: t.clientY, moved: false } : null;
    if (drag && dialog.style) {
      dialog.style.transition = 'none';
    }
  };
  const onMove = (ev) => {
    const t = ev.touches?.[0];
    if (!drag || !t) {
      return;
    }
    const dy = t.clientY - drag.y;
    if (dy > 6 && dy > Math.abs(t.clientX - drag.x)) {
      drag.moved = true;
      if (dialog.style) {
        dialog.style.transform = `translateY(${Math.min(dy, 240)}px)`;
      }
    }
  };
  const onEnd = (ev) => {
    const t = ev.changedTouches?.[0];
    const cur = drag;
    drag = null;
    if (!cur || !t) {
      resetDialogDrag(dialog, Boolean(cur?.moved));
      return;
    }
    const dy = t.clientY - cur.y;
    if (dy >= SWIPE_MIN_PX && dy > Math.abs(t.clientX - cur.x) * SWIPE_RATIO) {
      resetDialogDrag(dialog, false);
      dialog.close?.();
      return;
    }
    resetDialogDrag(dialog, cur.moved);
  };
  return { onStart, onMove, onEnd };
}

function bindDialogBackdropAndSwipe(doc) {
  const dialog = doc.querySelector('#form-dialog');
  if (!dialog) {
    return;
  }
  dialog.addEventListener('click', (ev) => {
    if (ev.target === dialog) {
      dialog.close?.();
    }
  });
  const ctl = createDialogDragController(dialog);
  dialog.addEventListener('touchstart', ctl.onStart, { passive: true });
  dialog.addEventListener('touchmove', ctl.onMove, { passive: true });
  dialog.addEventListener('touchend', ctl.onEnd, { passive: true });
  dialog.addEventListener('touchcancel', ctl.onEnd, { passive: true });
}

function scheduleNextMinuteTick(ctrl) {
  clearTimeout(ctrl.timer);
  ctrl.timer = null;
  const hidden = typeof document !== 'undefined' &&
    document.visibilityState === 'hidden';
  if (ctrl.disposed || hidden ||
      ctrl.ui.store.getState().page !== 'agenda') {
    return;
  }
  const delay = (60000 - (Date.now() % 60000)) + 50;
  ctrl.timer = setTimeout(() => {
    ctrl.timer = null;
    if (!ctrl.disposed && ctrl.ui.store.getState().page === 'agenda') {
      ctrl.ui.render();
      scheduleNextMinuteTick(ctrl);
    }
  }, delay);
}

export function attachMobileUx(ui, hooks) {
  const content = ui.doc.querySelector('#content');
  if (content) {
    bindMonthSwipeGesture(ui, content, hooks.onMonthDelta);
  }
  bindDialogBackdropAndSwipe(ui.doc);
  const ctrl = { ui, timer: null, disposed: false };
  const unsub = ui.store.subscribe(() => scheduleNextMinuteTick(ctrl));
  const onVis = () => {
    if (typeof document !== 'undefined' &&
        document.visibilityState !== 'hidden') {
      if (ui.store.getState().page === 'agenda') {
        ui.render();
      }
      scheduleNextMinuteTick(ctrl);
    } else {
      clearTimeout(ctrl.timer);
      ctrl.timer = null;
    }
  };
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('visibilitychange', onVis);
  }
  if (typeof window !== 'undefined') {
    window.__pocketHandleBack = () => handleAppBack(ui, hooks.onNavigate);
  }
  scheduleNextMinuteTick(ctrl);
  return () => {
    ctrl.disposed = true;
    clearTimeout(ctrl.timer);
    unsub();
    if (typeof document !== 'undefined' && document.removeEventListener) {
      document.removeEventListener('visibilitychange', onVis);
    }
    if (typeof window !== 'undefined' && window.__pocketHandleBack) {
      delete window.__pocketHandleBack;
    }
  };
}
