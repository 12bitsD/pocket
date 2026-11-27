import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cleanInlineTokens,
  parseInlineSchedule
} from '../src/domain/todo-model.js';
import { createAppStore } from '../src/state/app-store.js';
import {
  renderAgendaView,
  renderMonthView
} from '../src/ui/agenda-month-view.js';
import {
  buildEventDialogHtml,
  buildTodoDialogHtml
} from '../src/ui/dialogs.js';
import {
  handleDialogClick,
  syncEventEndOnStartEdit,
  updateFormDialogDom
} from '../src/ui/dialog-handlers.js';
import { toggleSecretInput } from '../src/ui/dom-handlers.js';
import { handleAppBack } from '../src/ui/mobile-ux.js';
import { handlePickerClick } from '../src/ui/pickers.js';
import { renderSettingsView } from '../src/ui/settings-view.js';
import { renderTodoView } from '../src/ui/todo-view.js';
import { buildTtyBarHtml } from '../src/ui/underlay.js';

test('parses inline schedule keywords and cleans quick composer text', () => {
  assert.deepEqual(
    parseInlineSchedule('晨跑 @me 每天 07:00'),
    { schedule: '每天', weeklyDow: null }
  );
  assert.deepEqual(
    parseInlineSchedule('汇总周报 @work-agent 每周五 17:30'),
    { schedule: '每周', weeklyDow: 5 }
  );
  assert.deepEqual(
    parseInlineSchedule('周日复盘 @me 每周日 20:00'),
    { schedule: '每周', weeklyDow: 0 }
  );
  assert.equal(
    cleanInlineTokens('汇总周报 @work-agent 每周五 17:30', ['@work-agent']),
    '汇总周报'
  );
});

test('navigates Android/mobile back stack from dialog -> settings -> agenda',
  () => {
    const store = createAppStore({
      clock: () => new Date(2026, 10, 24, 9, 0, 0)
    });
    let dialogOpen = true;
    const dialog = {
      get open() {
        return dialogOpen;
      },
      close: () => {
        dialogOpen = false;
      },
      removeAttribute: () => {}
    };
    const ui = {
      doc: { querySelector: (sel) => (sel === '#form-dialog' ? dialog : null) },
      store
    };
    const navCalls = [];
    const onNavigate = (page) => {
      navCalls.push(page);
      store.setViewState({ page });
    };

    store.setViewState({ page: 'month' });
    store.setViewState({ page: 'settings' });
    assert.equal(handleAppBack(ui, onNavigate), true);
    assert.equal(dialogOpen, false);
    assert.deepEqual(navCalls, []);

    assert.equal(handleAppBack(ui, onNavigate), true);
    assert.equal(store.getState().page, 'month');

    assert.equal(handleAppBack(ui, onNavigate), true);
    assert.equal(store.getState().page, 'agenda');

    assert.equal(handleAppBack(ui, onNavigate), false);
    store.destroy();
  });

test('auto-advances end time on start edit and toggles secret inputs', () => {
  const startEl = { value: '14:30' };
  const endEl = { value: '11:00' };
  const form = {
    querySelector: (sel) => {
      if (sel === '#ev-start') {
        return startEl;
      }
      return sel === '#ev-end' ? endEl : null;
    }
  };
  syncEventEndOnStartEdit(form, { target: { id: 'ev-start' } });
  assert.equal(endEl.value, '15:30');

  const secretInput = { type: 'password' };
  const toggleBtn = { dataset: { toggleSecret: 'ag-key' }, textContent: '显示' };
  const box = {
    querySelector: (sel) => (sel === '#ag-key' ? secretInput : null)
  };
  toggleSecretInput(box, toggleBtn);
  assert.equal(secretInput.type, 'text');
  assert.equal(toggleBtn.textContent, '隐藏');
  toggleSecretInput(box, toggleBtn);
  assert.equal(secretInput.type, 'password');
  assert.equal(toggleBtn.textContent, '显示');
});

test('renders empty states, past-event retreat, and offline queue badges',
  () => {
    const store = createAppStore({
      clock: () => new Date(2026, 10, 24, 22, 30, 0)
    });
    const base = store.getState();
    const lateAgenda = renderAgendaView(
      base, Date.parse('2026-11-24T23:30:00')
    );
    assert.ok(lateAgenda.includes('今日已结束 · 末场回顾'));
    assert.ok(lateAgenda.includes('class="row disabled"'));

    const monthHtml = renderMonthView(base);
    assert.ok(monthHtml.includes('aria-label="2026-11-24'));

    const emptyTodoHtml = renderTodoView({ ...base, todos: [] });
    assert.ok(emptyTodoHtml.includes('暂无待办或唤醒任务'));

    const queuedState = {
      ...base,
      mode: 'cloud',
      connectionStatus: 'suspended',
      baseUrl: 'https://pocket.example.com',
      identity: { kind: 'device', label: 'Phone', scopes: ['*'] },
      agentGrants: [],
      activePairing: { code: '849201' },
      offlineQueue: { mutations: [{}], receipts: [{}] }
    };
    const tty = buildTtyBarHtml(queuedState);
    assert.ok(tty.statHtml.includes('IDLE · SAVING · queue 2'));
    const settingsHtml = renderSettingsView(queuedState);
    assert.ok(settingsHtml.includes('待同步队列 2 项'));
    assert.ok(settingsHtml.includes('复制配对码'));
    assert.ok(settingsHtml.includes('尚未绑定外部 Agent'));
    store.destroy();
  });

test('normalizes uppercase mobile @Agent handles and applies duration chips',
  async () => {
    const store = createAppStore({
      clock: () => new Date(2026, 10, 24, 9, 0, 0)
    });
    const saved = await store.saveAgent({
      agentId: '  @Work-Mobile-Bot  ',
      name: 'Mobile Bot',
      endpointUrl: 'https://bot.example.com',
      credential: 'sec_1'
    });
    assert.equal(saved.agent_id, '@work-mobile-bot');

    const startEl = { value: '13:15' };
    const endEl = { value: '14:15' };
    const previewEl = { innerHTML: '' };
    const form = {
      dataset: { kind: 'event' },
      querySelector: (sel) => {
        if (sel === '#ev-start') {
          return startEl;
        }
        if (sel === '#ev-end') {
          return endEl;
        }
        if (sel === '#cli-preview') {
          return previewEl;
        }
        return null;
      }
    };
    const ui = {
      doc: {
        querySelector: (sel) => (sel === '#active-form' ? form : { close() {} })
      },
      store,
      editingId: null
    };
    const durBtn = { dataset: { durMins: '120' } };
    handleDialogClick(ui, {
      target: { closest: (s) => (s === '[data-dur-mins]' ? durBtn : null) }
    });
    assert.equal(endEl.value, '15:15');
    assert.ok(previewEl.innerHTML.includes('13:15..15:15'));

    endEl.value = '12:00';
    updateFormDialogDom(form, '2026-11-24');
    assert.ok(previewEl.innerHTML.includes('13:15..13:45 (自动顺延 +30m)'));
    store.destroy();
  });

function makePickerMockRoot(timeInput, labelEl, slotEl) {
  return {
    querySelector: (sel) => {
      if (sel === '#ev-start') {
        return timeInput;
      }
      if (sel === '[data-picker-label="ev-start"]') {
        return labelEl;
      }
      return sel === '[data-picker-slot="ev-start"]' ? slotEl : null;
    },
    querySelectorAll: () => []
  };
}

test('uses custom paper time/date pickers with no native OS pickers', () => {
  const store = createAppStore({
    clock: () => new Date(2026, 10, 27, 13, 15, 0)
  });
  const st = store.getState();
  const views = [
    buildEventDialogHtml(st, null),
    buildTodoDialogHtml(st, null),
    renderTodoView(st)
  ];
  for (const html of views) {
    assert.equal(html.includes('type="time"'), false);
    assert.equal(html.includes('type="date"'), false);
    assert.equal(html.includes('<select'), false);
  }
  const timeInput = { value: '13:10' };
  const labelEl = { textContent: '13:10' };
  const root = makePickerMockRoot(timeInput, labelEl, {
    hidden: false,
    innerHTML: ''
  });
  const changes = [];
  const stepBtn = { dataset: { pickMinStep: '1', pickerTarget: 'ev-start' } };
  const fakeEvent = {
    target: { closest: (s) => (s === '[data-pick-min-step]' ? stepBtn : null) }
  };
  const handled = handlePickerClick(
    root, fakeEvent, '2026-11-27', (tid, val) => changes.push([tid, val])
  );
  assert.equal(handled, true);
  assert.equal(timeInput.value, '13:11');
  assert.equal(labelEl.textContent, '13:11');
  assert.deepEqual(changes, [['ev-start', '13:11']]);
  assert.ok(
    views[0].includes('</div>\n      <div class="picker-slot"'),
    'time picker slots must sit full-width below range row'
  );
  store.destroy();
});
