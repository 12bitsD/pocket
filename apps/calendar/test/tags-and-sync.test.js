import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cleanInlineTokens,
  parseInlineTags
} from '../src/domain/todo-model.js';
import { createAppStore } from '../src/state/app-store.js';
import { parsePairingQrPayload } from '../src/state/integration-actions.js';
import { buildTodoDialogHtml } from '../src/ui/dialogs.js';
import { renderSettingsView } from '../src/ui/settings-view.js';
import { renderTodoView } from '../src/ui/todo-view.js';

test('parses inline #tags, stacks todo decks, and edits tags', async () => {
  assert.deepEqual(parseInlineTags('买咖啡 #生活 #个人'), ['生活', '个人']);
  assert.equal(cleanInlineTokens('买咖啡 #生活 @me 08:30', []), '买咖啡');

  const store = createAppStore({
    clock: () => new Date(2026, 10, 27, 9, 0, 0)
  });
  const saved = await store.saveTodo({
    text: '准备周会材料',
    assignee: 'none',
    tags: ['工作', '项目']
  });
  assert.deepEqual(saved.tags, ['工作', '项目']);

  const html = renderTodoView(store.getState());
  assert.ok(html.includes('data-filter-tag="工作"'));
  assert.ok(html.includes('data-fold-id="todo-tag-工作"'));
  assert.ok(html.includes('#工作'));

  const editHtml = buildTodoDialogHtml(store.getState(), saved.todo_id);
  assert.ok(editHtml.includes('id="td-tags"'));
  assert.ok(editHtml.includes('data-dialog-tag="工作" aria-pressed="true"'));
  store.destroy();
});

test('renders collapsible folds, QR pairing, and Feishu sync entry', () => {
  const parsed = parsePairingQrPayload(
    'pocket://pair?url=https%3A%2F%2Fcloud.example.com&code=482910'
  );
  assert.deepEqual(parsed, {
    baseUrl: 'https://cloud.example.com',
    code: '482910'
  });
  assert.equal(parsePairingQrPayload('not-a-valid-uri'), null);

  const store = createAppStore({
    isNativeAndroid: true,
    clock: () => new Date(2026, 10, 27, 9, 0, 0)
  });
  const html = renderSettingsView(store.getState(), { authTab: 'claim' });
  assert.ok(html.includes('data-fold-id="cloud"'));
  assert.ok(html.includes('data-fold-id="sync"'));
  assert.ok(html.includes('data-scan-pair-qr'));
  assert.ok(html.includes('data-feishu-connect'));
  assert.ok(html.includes('关联手机本地日历'));
  store.destroy();
});
