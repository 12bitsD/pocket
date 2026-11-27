import { describeConnection } from '../domain/calendar-model.js';
import { escapeHtml } from '../domain/date-time.js';
import { buildAppUpdateRowHtml } from '../native/update-bridge.js';
import {
  buildExternalCalendarsFoldHtml,
  buildPairBoxHtml,
  buildTokensFoldHtml
} from './settings-sections.js';

const PERMISSION_ITEMS = Object.freeze([
  Object.freeze(['exactAlarm', '精确闹钟权限', 'SCHEDULE_EXACT_ALARM']),
  Object.freeze(['notifications', '通知横幅与铃声', 'POST_NOTIFICATIONS']),
  Object.freeze(['fullScreenIntent', '锁屏全屏唤醒', 'USE_FULL_SCREEN_INTENT']),
  Object.freeze([
    'batteryOptimization',
    '后台省电白名单',
    'IGNORE_BATTERY_OPTIMIZATIONS'
  ])
]);

function buildConnectionBadge(state) {
  const conn = describeConnection(state);
  return `<span class="fold-badge">` +
    `<i class="dot ${conn.dotClass}" aria-hidden="true"></i>` +
    `${escapeHtml(conn.label)}</span>`;
}

function buildConnectedCloudBody(state, canAdmin) {
  const pairBtn = canAdmin
    ? '<button class="cmd-quiet outlined" type="button" data-create-pair>' +
      '生成配对二维码</button>'
    : '';
  const qLen = (state.offlineQueue?.mutations?.length || 0) +
    (state.offlineQueue?.receipts?.length || 0);
  const queueNotice = qLen > 0
    ? `<div class="mark-tag lock">待同步队列 ${qLen} 项 · 恢复在线后自动重放</div>`
    : '';
  const label = state.identity?.label || 'Pocket Session';
  const src = state.identity?.source || 'web';
  const seq = escapeHtml(state.lastSeq);
  return `<div class="stack-sm fold-body">
    <div class="jc-spec">
      ${escapeHtml(state.baseUrl)} · ${escapeHtml(label)} (${escapeHtml(src)})
      · seq #${seq}
    </div>
    ${queueNotice}
    ${buildPairBoxHtml(state.activePairing)}
    <div class="hero-foot">
      <div class="inline-actions">
        ${pairBtn}
        <button class="cmd-quiet outlined" type="button" data-disconnect-cloud>
          断开切回本地
        </button>
      </div>
      <span class="receipt-code">/v1/link WS</span>
    </div>
  </div>`;
}

function buildClaimFormHtml(urlVal) {
  return `<form class="stack-sm" id="pair-claim-form">
    <div class="field">
      <label for="claim-url-input">CLOUD URL</label>
      <input id="claim-url-input" name="baseUrl" type="url" inputmode="url"
        autocapitalize="off" spellcheck="false" value="${urlVal}" required>
    </div>
    <div class="dialog-split">
      <div class="field">
        <label for="claim-code-input">6-DIGIT CODE</label>
        <input class="date-input" id="claim-code-input" name="code"
          inputmode="numeric" autocomplete="one-time-code" enterkeyhint="go"
          pattern="\\d{6}" maxlength="6" placeholder="123456" required>
      </div>
      <div class="field">
        <label for="claim-name-input">DEVICE NAME</label>
        <input id="claim-name-input" name="name" value="My Phone" required>
      </div>
    </div>
    <button class="btn-block primary" type="submit">用配对码绑定本机</button>
  </form>`;
}

function buildLoginFormHtml(urlVal) {
  return `<form class="stack-sm" id="cloud-login-form">
    <div class="field">
      <label for="cloud-url-input">CLOUD URL</label>
      <input id="cloud-url-input" name="baseUrl" type="url" inputmode="url"
        autocapitalize="off" spellcheck="false"
        placeholder="https://pocket.example.com" value="${urlVal}" required>
    </div>
    <div class="field">
      <label for="cloud-token-input">BOOTSTRAP / WEB TOKEN</label>
      <div class="secret-row">
        <input id="cloud-token-input" name="token" type="password"
          autocapitalize="off" spellcheck="false" autocomplete="off"
          placeholder="输入主密钥或 pck_ 令牌" required>
        <button class="cmd-quiet outlined mini" type="button"
          data-toggle-secret="cloud-token-input">显示</button>
      </div>
    </div>
    <button class="btn-block primary" type="submit">连接 Pocket Cloud</button>
  </form>`;
}

function buildDisconnectedCloudBody(state, authTab) {
  const urlVal = escapeHtml(state.baseUrl || 'http://127.0.0.1:8787');
  const isClaim = authTab === 'claim';
  const formHtml = isClaim
    ? buildClaimFormHtml(urlVal)
    : buildLoginFormHtml(urlVal);
  const scanBtn = state.isNativeAndroid
    ? '<button class="btn-block primary" type="button" data-scan-pair-qr>' +
      '扫码一键连接 Pocket Cloud</button>'
    : '<form class="secret-row" id="pair-uri-form">' +
      '<input name="pairUri" placeholder="粘贴 pocket://pair?... 配对链接" ' +
      'autocapitalize="off" spellcheck="false" required>' +
      '<button class="cmd-quiet outlined mini" type="submit">直连</button>' +
      '</form>';
  return `<div class="stack-sm fold-body">
    ${scanBtn}
    <div class="seg-bar">
      <button type="button" data-auth-tab="login"
        aria-pressed="${!isClaim}">密钥登录</button>
      <button type="button" data-auth-tab="claim"
        aria-pressed="${isClaim}">6 位码绑定本机</button>
    </div>
    ${formHtml}
  </div>`;
}

function buildPermissionRowHtml(perms, item) {
  const [key, label, code] = item;
  const ready = Boolean(perms[key]);
  const btnText = ready ? '已就绪' : '去开启';
  const aria = escapeHtml(`${btnText}：${label} (${code})`);
  return `<div class="row compact">
    <span>
      <span class="row-title">${label}</span>
      <span class="row-meta">${code}</span>
    </span>
    <div class="inline-actions">
      <span class="receipt-code">` +
        `<i class="dot ${ready ? 'ok' : 'mark'}" aria-hidden="true"></i>` +
        `${ready ? 'READY' : 'REQUIRED'}</span>
      <button class="cmd-quiet outlined mini" type="button"
        aria-label="${aria}" data-perm-jump="${key}">${btnText}</button>
    </div>
  </div>`;
}

function buildPermissionsCardHtml(perms, openFolds) {
  if (!perms) {
    return '';
  }
  const readyCount = PERMISSION_ITEMS.filter(([k]) => Boolean(perms[k])).length;
  const allReady = readyCount === PERMISSION_ITEMS.length;
  const badgeText = allReady ? '全部就绪' : `${readyCount}/4 就绪`;
  const rowsHtml = PERMISSION_ITEMS
    .map((item) => buildPermissionRowHtml(perms, item))
    .join('');
  const openAttr = openFolds?.has('perms') ? 'open' : '';
  return `<details class="fold" data-fold-id="perms" ${openAttr}>
    <summary>
      <span>DEVICE ALARM PERMISSIONS (4)</span>
      <span class="fold-badge">` +
        `<i class="dot ${allReady ? 'ok' : 'mark'}"></i>${badgeText}</span>
    </summary>
    <div class="stack-sm fold-body">
      <div class="inline-actions">
        <button class="cmd-quiet outlined mini" type="button"
          data-perm-test-ring>测试响铃</button>
        <button class="cmd-quiet outlined mini" type="button"
          aria-label="重新自检设备响铃权限" data-perm-refresh>自检</button>
      </div>
      <div class="rows" role="group" aria-label="设备闹钟权限自检">
        ${rowsHtml}
      </div>
    </div>
  </details>`;
}

function buildMintedTokenBanner(state) {
  const minted = state.lastMintedToken;
  if (!minted?.token) {
    return '';
  }
  const secret = escapeHtml(minted.token);
  return `<div class="token-banner" role="region" aria-label="新签发令牌">
    <div class="jc-head">
      <span><b>一次性明文密钥</b> · ${escapeHtml(minted.label)}</span>
      <div class="inline-actions">
        <button class="cmd-quiet outlined mini" type="button"
          data-copy-token="${secret}">复制</button>
        <button class="cmd-quiet mini" type="button"
          data-dismiss-token>关闭</button>
      </div>
    </div>
    <div class="token-secret">${secret}</div>
  </div>`;
}

function buildAgentCardHtml(ag, canAdmin) {
  const disAttr = canAdmin ? '' : 'disabled';
  const stateCls = ag.active === false ? 'expired' : '';
  const statusTag = ag.active === false ? 'INACTIVE' : 'ACTIVE';
  const id = escapeHtml(ag.agent_id);
  const revokeBtn = ag.active === false || !canAdmin
    ? ''
    : `<button class="cmd-quiet mini" type="button" ` +
      `data-revoke-agent="${id}">停用</button>`;
  const urlText = escapeHtml(ag.endpoint_url || '未配置 Webhook 地址');
  return `<article class="job-card ${stateCls}">
    <div class="jc-head">
      <span class="jc-target"><b>${id}</b> · ${escapeHtml(ag.name)}</span>
      <div class="date-shortcuts">
        <button class="dip-switch" type="button" ${disAttr}
          aria-pressed="${Boolean(ag.canRead)}"
          data-grant-read="${id}"><i></i>READ</button>
        <button class="dip-switch" type="button" ${disAttr}
          aria-pressed="${Boolean(ag.canWrite)}"
          data-grant-write="${id}"><i></i>WRITE</button>
      </div>
    </div>
    <div class="jc-spec">${urlText}</div>
    <div class="jc-out">
      <code>${statusTag}</code>
      <div class="inline-actions">
        <button class="cmd-quiet outlined mini" type="button"
          data-edit-agent="${id}">编辑</button>
        ${revokeBtn}
      </div>
    </div>
  </article>`;
}

function buildThemeRowHtml(theme) {
  const isDark = theme === 'black';
  return `<div class="row compact">
    <span class="row-title">纸面主题</span>
    <div class="seg-bar compact-seg">
      <button type="button" data-set-theme="white"
        aria-pressed="${!isDark}">暖白纸</button>
      <button type="button" data-set-theme="black"
        aria-pressed="${isDark}">夜间炭纸</button>
    </div>
  </div>`;
}

function buildAgentsSectionHtml(state, canAdmin) {
  if (state.agentGrants.length === 0) {
    return '<div class="empty">尚未绑定外部 Agent<br>' +
      '<button class="cmd-quiet outlined" type="button" data-open-agent>' +
      '+ 绑定首个 Agent</button></div>';
  }
  const cards = state.agentGrants
    .map((ag) => buildAgentCardHtml(ag, canAdmin))
    .join('');
  return `<div class="jobs">${cards}</div>`;
}

export function renderSettingsView(state, uiPrefs) {
  const authTab = uiPrefs?.authTab ||
    (state.isNativeAndroid ? 'claim' : 'login');
  const openFolds = uiPrefs?.openFolds || null;
  const connected = state.mode === 'cloud' &&
    state.connectionStatus !== 'revoked';
  const canAdmin = Boolean(state.canAdmin);
  const heroBody = connected
    ? buildConnectedCloudBody(state, canAdmin)
    : buildDisconnectedCloudBody(state, authTab);
  const cloudOpen = openFolds?.has('cloud') ? 'open' : '';
  return `<div class="foreground-stack">
    <article class="hero">
      <details class="fold hero-fold" data-fold-id="cloud" ${cloudOpen}>
        <summary>
          <span class="t-minus">POCKET CLOUD LINK</span>
          ${buildConnectionBadge(state)}
        </summary>
        ${heroBody}
      </details>
    </article>
    ${buildPermissionsCardHtml(state.nativePermissions, openFolds)}
    ${buildExternalCalendarsFoldHtml(state, openFolds)}
    ${buildMintedTokenBanner(state)}
    <div class="rows">
      ${buildThemeRowHtml(state.theme)}${buildAppUpdateRowHtml(state)}
    </div>
    <div class="col-head">
      <span>BOUND AGENTS (${state.agentGrants.length})</span>
      <button class="cmd-quiet outlined mini" type="button"
        data-open-agent>+ 绑定 Agent</button>
    </div>
    ${buildAgentsSectionHtml(state, canAdmin)}
    ${buildTokensFoldHtml(state, state.mode === 'cloud' && canAdmin, openFolds)}
    <p class="man-line kbd-hint">
      快捷键：[d] 今日 · [m] 月历 · [t] Todo · [c] 配置 · [n] 新建 · [b] 纸色
    </p>
  </div>`;
}
