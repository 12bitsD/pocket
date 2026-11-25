import { describeConnection } from '../domain/calendar-model.js';
import { escapeHtml } from '../domain/date-time.js';

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
  return `<span class="receipt-code">` +
    `<i class="dot ${conn.dotClass}" aria-hidden="true"></i>` +
    `${escapeHtml(conn.label)}</span>`;
}

function buildPairBoxHtml(activePairing) {
  if (!activePairing) {
    return '';
  }
  const code = escapeHtml(activePairing.code);
  return `<div class="pair-box">
      <span class="pair-code">${code}</span>
      <div class="inline-actions">
        <span class="jc-spec">5m 内有效 · 手机输入绑定</span>
        <button class="cmd-quiet outlined mini" type="button"
          data-copy-token="${code}">复制配对码</button>
      </div>
    </div>`;
}

function buildConnectedCloudBody(state, canAdmin) {
  const pairBtn = canAdmin
    ? '<button class="cmd-quiet outlined" type="button" data-create-pair>' +
      '生成 6 位配对码</button>'
    : '';
  const qLen = (state.offlineQueue?.mutations?.length || 0) +
    (state.offlineQueue?.receipts?.length || 0);
  const queueNotice = qLen > 0
    ? `<div class="mark-tag lock">待同步队列 ${qLen} 项 · 恢复在线后自动重放</div>`
    : '';
  const label = state.identity?.label || 'Pocket Session';
  const src = state.identity?.source || 'web';
  const seq = escapeHtml(state.lastSeq);
  return `<div class="stack-sm">
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
  return `<div class="stack-sm">
    <div class="seg-bar">
      <button type="button" data-auth-tab="login"
        aria-pressed="${!isClaim}">密钥登录</button>
      <button type="button" data-auth-tab="claim"
        aria-pressed="${isClaim}">6 位码绑定本机</button>
    </div>
    ${formHtml}
  </div>`;
}

function buildPermissionsCardHtml(perms) {
  if (!perms) {
    return '';
  }
  const rowsHtml = PERMISSION_ITEMS.map(([key, label, code]) => {
    const ready = Boolean(perms[key]);
    const dotCls = ready ? 'ok' : 'mark';
    const stamp = ready ? 'READY' : 'REQUIRED';
    const btnText = ready ? '已就绪' : '去开启';
    const aria = escapeHtml(`${btnText}：${label} (${code})`);
    return `<div class="row compact">
      <span>
        <span class="row-title">${label}</span>
        <span class="row-meta">${code}</span>
      </span>
      <div class="inline-actions">
        <span class="receipt-code">` +
          `<i class="dot ${dotCls}" aria-hidden="true"></i>${stamp}</span>
        <button class="cmd-quiet outlined mini" type="button"
          aria-label="${aria}" data-perm-jump="${key}">${btnText}</button>
      </div>
    </div>`;
  }).join('');
  return `<div class="col-head">
      <span>DEVICE ALARM PERMISSIONS (4)</span>
      <button class="cmd-quiet outlined mini" type="button"
        aria-label="重新自检设备响铃权限" data-perm-refresh>重新自检</button>
    </div>
    <div class="rows" role="group" aria-label="设备闹钟权限自检">
      ${rowsHtml}
    </div>`;
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

function buildTokensFoldHtml(state, canAdmin) {
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
  return `<details class="fold">
    <summary>TOKENS &amp; DEVICES (${activeTokens.length})</summary>
    <div class="stack-sm" style="margin-top:8px">
      <div class="inline-actions">
        <button class="cmd-quiet outlined mini" type="button"
          data-mint-web-token>+ 签发 Web 令牌</button>
      </div>
      <div class="rows">${rows}</div>
    </div>
  </details>`;
}

export function renderSettingsView(state, uiPrefs) {
  const defaultTab = state.isNativeAndroid ? 'claim' : 'login';
  const authTab = uiPrefs?.authTab || defaultTab;
  const connected = state.mode === 'cloud' &&
    state.connectionStatus !== 'revoked';
  const canAdmin = Boolean(state.canAdmin);
  const heroBody = connected
    ? buildConnectedCloudBody(state, canAdmin)
    : buildDisconnectedCloudBody(state, authTab);
  const agentsHtml = state.agentGrants
    .map((ag) => buildAgentCardHtml(ag, canAdmin))
    .join('');
  const emptyAgents = '<div class="empty">尚未绑定外部 Agent<br>' +
    '<button class="cmd-quiet outlined" type="button" data-open-agent>' +
    '+ 绑定首个 Agent</button></div>';
  const agentsSection = state.agentGrants.length > 0
    ? `<div class="jobs">${agentsHtml}</div>`
    : emptyAgents;
  return `<div class="foreground-stack">
    <article class="hero">
      <div class="hero-top">
        <span class="t-minus">POCKET CLOUD LINK</span>
        ${buildConnectionBadge(state)}
      </div>
      ${heroBody}
    </article>
    ${buildPermissionsCardHtml(state.nativePermissions)}
    ${buildMintedTokenBanner(state)}
    <div class="col-head">
      <span>BOUND AGENTS (${state.agentGrants.length})</span>
      <button class="cmd-quiet outlined mini" type="button"
        data-open-agent>+ 绑定 Agent</button>
    </div>
    ${agentsSection}
    ${buildTokensFoldHtml(state, state.mode === 'cloud' && canAdmin)}
    <p class="man-line">
      快捷键：[d] 今日 · [m] 月历 · [t] Todo · [c] 配置 · [n] 新建 · [b] 纸色
    </p>
  </div>`;
}
