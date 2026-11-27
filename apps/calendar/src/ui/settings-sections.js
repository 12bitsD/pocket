import { escapeHtml } from '../domain/date-time.js';
import { TODO_PRESET_TAGS, normalizeTodoTags } from '../domain/todo-model.js';

export function buildPairBoxHtml(activePairing) {
  if (!activePairing) {
    return '';
  }
  const code = escapeHtml(activePairing.code);
  const uri = escapeHtml(activePairing.pair_uri || '');
  const qrHtml = activePairing.qr_svg
    ? `<div class="pair-qr" aria-label="扫码配对二维码">${activePairing.qr_svg}</div>`
    : '';
  const copyUriBtn = uri
    ? `<button class="cmd-quiet outlined mini" type="button" ` +
      `data-copy-token="${uri}">复制扫码链接</button>`
    : '';
  return `<div class="pair-box">
      ${qrHtml}
      <div class="pair-meta-col">
        <span class="pair-code">${code}</span>
        <span class="jc-spec">手机扫码直连 · 5m 内有效</span>
        <div class="inline-actions">
          <button class="cmd-quiet outlined mini" type="button"
            data-copy-token="${code}">复制配对码</button>
          ${copyUriBtn}
        </div>
      </div>
    </div>`;
}

function formatSyncShortTime(iso) {
  if (!iso) {
    return '尚未同步';
  }
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) {
    return '已同步';
  }
  const hh = String(dt.getHours()).padStart(2, '0');
  const mm = String(dt.getMinutes()).padStart(2, '0');
  return `上次同步 ${hh}:${mm}`;
}

function buildFeishuRowHtml(feishu, connectedCloud) {
  const bound = Boolean(feishu?.connected);
  const dotCls = bound ? 'ok' : (feishu?.last_error ? 'mark' : 'off');
  const metaText = bound
    ? `${formatSyncShortTime(feishu.last_synced_at)} · ` +
      `${feishu.event_count || 0} 条日程`
    : (feishu?.last_error || '由服务端 OAuth 双向同步，客户端免维护');
  const actions = bound
    ? '<button class="cmd-quiet outlined mini" type="button" ' +
        'data-feishu-sync>立即同步</button>' +
      '<button class="cmd-quiet mini" type="button" ' +
        'data-feishu-unbind>解绑</button>'
    : `<button class="cmd-quiet outlined mini" type="button" ` +
      `${connectedCloud ? '' : 'disabled'} data-feishu-connect>` +
      `${feishu?.configured ? '一键授权飞书' : '配置并绑定'}</button>`;
  return `<div class="row compact">
    <span>
      <span class="row-title">
        <i class="dot ${dotCls}" aria-hidden="true"></i> 飞书日历（双向同步）
      </span>
      <span class="row-meta">${escapeHtml(metaText)}</span>
    </span>
    <div class="inline-actions">${actions}</div>
  </div>`;
}

export function buildExternalCalendarsFoldHtml(state, openFolds) {
  const integrations = state.integrations || [];
  const feishu = integrations.find((i) => i.provider === 'feishu') || null;
  const connectedCloud = state.mode === 'cloud' &&
    state.connectionStatus !== 'revoked';
  const badge = feishu?.connected
    ? '<span class="fold-badge"><i class="dot ok"></i>飞书已连接</span>'
    : '<span class="fold-badge">未绑定</span>';
  const openAttr = openFolds?.has('sync') ? 'open' : '';
  const localRow = `<div class="row compact">
    <span>
      <span class="row-title">关联手机本地日历</span>
      <span class="row-meta">系统日历读写桥接 · 规划中</span>
    </span>
    <span class="mark-tag neutral">即将支持</span>
  </div>`;
  return `<details class="fold" data-fold-id="sync" ${openAttr}>
    <summary><span>外部日历同步（飞书 / 本地）</span>${badge}</summary>
    <div class="rows fold-body">
      ${buildFeishuRowHtml(feishu, connectedCloud)}
      ${localRow}
    </div>
  </details>`;
}

export function buildFeishuDialogHtml(state) {
  const feishu = (state.integrations || [])
    .find((i) => i.provider === 'feishu');
  const appId = escapeHtml(feishu?.app_id || '');
  const secPlaceholder = feishu?.configured
    ? '留空则保留服务端已加密密钥'
    : '输入飞书自建应用 App Secret';
  const secReq = feishu?.configured ? '' : 'required';
  return `
    <p class="row-meta">
      配置飞书开放平台自建应用凭据后，将由 Pocket Cloud 后端加密保管并定时双向同步。
    </p>
    <div class="field">
      <label for="fsh-app-id">飞书 App ID</label>
      <input id="fsh-app-id" name="appId" placeholder="cli_xxxxxxxx"
        autocapitalize="off" spellcheck="false" autocomplete="off"
        value="${appId}" required>
    </div>
    <div class="field">
      <label for="fsh-app-secret">飞书 App Secret</label>
      <div class="secret-row">
        <input id="fsh-app-secret" name="appSecret" type="password"
          autocapitalize="off" spellcheck="false" autocomplete="off"
          placeholder="${secPlaceholder}" ${secReq}>
        <button class="cmd-quiet outlined mini" type="button"
          data-toggle-secret="fsh-app-secret">显示</button>
      </div>
    </div>
    <button class="btn-block primary" type="submit">保存并一键授权飞书</button>`;
}

export function buildTodoTagPickerHtml(state, selectedTags, disAttr) {
  const activeSet = new Set(normalizeTodoTags(selectedTags));
  const pool = [...TODO_PRESET_TAGS];
  for (const td of state.todos || []) {
    for (const tag of normalizeTodoTags(td.tags)) {
      if (!pool.includes(tag)) {
        pool.push(tag);
      }
    }
  }
  const chips = pool.map((tag) => {
    const safe = escapeHtml(tag);
    const pressed = activeSet.has(tag);
    return `<button class="route-pill" type="button" ${disAttr} ` +
      `data-dialog-tag="${safe}" aria-pressed="${pressed}">#${safe}</button>`;
  }).join('');
  const rawVal = escapeHtml([...activeSet].join(' '));
  return `<div class="field">
    <label for="td-tags">标签分类</label>
    <div class="chip-strip">${chips}</div>
    <input id="td-tags" name="tags" ${disAttr}
      placeholder="自定义标签（空格分隔，如 采购 复盘）"
      value="${rawVal}" autocomplete="off">
  </div>`;
}

export function buildTokensFoldHtml(state, canAdmin, openFolds) {
  if (!canAdmin) {
    return '';
  }
  const activeTokens = state.tokens.filter((tok) => !tok.revoked_at);
  const rows = activeTokens.map((tok) => {
    const scopes = escapeHtml((tok.scopes || []).join(', '));
    const kind = escapeHtml(tok.kind);
    const id = escapeHtml(tok.token_id);
    const revokeBtn = tok.kind !== 'bootstrap'
      ? `<button class="cmd-quiet outlined mini" type="button" ` +
        `data-revoke-token="${id}">吊销</button>`
      : '<code>MASTER</code>';
    return `<div class="row compact">
      <span>
        <span class="row-title">
          ${escapeHtml(tok.label)}
          <span class="mark-tag neutral">${kind}</span>
        </span>
        <span class="row-meta">${scopes}</span>
      </span>
      ${revokeBtn}
    </div>`;
  }).join('');
  const openAttr = openFolds?.has('tokens') ? 'open' : '';
  return `<details class="fold" data-fold-id="tokens" ${openAttr}>
    <summary><span>TOKENS &amp; DEVICES (${activeTokens.length})</span></summary>
    <div class="stack-sm fold-body">
      <div class="inline-actions">
        <button class="cmd-quiet outlined mini" type="button"
          data-mint-web-token>+ 签发 Web 令牌</button>
      </div>
      <div class="rows">${rows}</div>
    </div>
  </details>`;
}
