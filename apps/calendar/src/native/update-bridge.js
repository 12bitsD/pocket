import { normalizeBaseUrl } from '../api/cloud-client.js';
import { escapeHtml } from '../domain/date-time.js';

export function buildAppUpdateBannerHtml(state) {
  const upd = state.appUpdate;
  if (!state.isNativeAndroid || !upd || state.appUpdateDismissed) {
    return '';
  }
  const ver = escapeHtml(upd.version_name || '');
  const note = upd.notes ? ` · ${escapeHtml(upd.notes)}` : '';
  return `<div class="perm-alert-bar" role="status">
    <span>发现新版 v${ver}${note}</span>
    <div class="inline-actions">
      <button class="cmd-primary mini" type="button"
        data-install-app-update>立即更新</button>
      <button class="ghost-chip" type="button" aria-label="忽略本次更新提示"
        data-dismiss-app-update>✕</button>
    </div>
  </div>`;
}

export function buildAppUpdateRowHtml(state) {
  if (!state.isNativeAndroid) {
    return '';
  }
  const cur = escapeHtml(state.installedApp?.versionName || '0.2.0');
  const upd = state.appUpdate;
  const sub = upd
    ? `有新版 v${escapeHtml(upd.version_name)}`
    : `当前 v${cur}`;
  const installBtn = upd
    ? '<button class="cmd-primary mini" type="button" ' +
      'data-install-app-update>立即更新</button>'
    : '';
  const checkBtn = state.mode === 'cloud'
    ? '<button class="cmd-quiet outlined mini" type="button" ' +
      'data-check-app-update>检查更新</button>'
    : '';
  return `<div class="row compact">
      <span>
        <span class="row-title">应用更新</span>
        <span class="row-meta">${sub}</span>
      </span>
      <div class="inline-actions">${checkBtn}${installBtn}</div>
    </div>`;
}

function isNewerRelease(installed, release) {
  if (!release || !Number.isFinite(Number(release.version_code))) {
    return false;
  }
  const curCode = Number(installed?.versionCode || 0);
  return Number(release.version_code) > curCode;
}

export async function ensureInstalledAppInfo(ctx) {
  if (ctx.state.installedApp) {
    return ctx.state.installedApp;
  }
  const plugin = ctx.updatePlugin;
  if (!plugin || typeof plugin.getAppInfo !== 'function') {
    return null;
  }
  try {
    const raw = await plugin.getAppInfo();
    const info = {
      versionName: String(raw?.versionName || '0.0.0'),
      versionCode: Number(raw?.versionCode || 0),
      canInstallUpdates: Boolean(raw?.canInstallUpdates)
    };
    ctx.state = { ...ctx.state, installedApp: info };
    ctx.notify();
    return info;
  } catch (err) {
    ctx.lastBridgeError = err;
    throw err;
  }
}

export async function applyIncomingRelease(ctx, release) {
  if (!ctx.isNative || !release) {
    return null;
  }
  const installed = await ensureInstalledAppInfo(ctx);
  if (!installed) {
    return null;
  }
  const nextUpdate = isNewerRelease(installed, release) ? release : null;
  const changed = ctx.state.appUpdate?.version_code !==
    nextUpdate?.version_code ||
    ctx.state.appUpdate?.sha256 !== nextUpdate?.sha256;
  ctx.state = {
    ...ctx.state,
    appUpdate: nextUpdate,
    appUpdateDismissed: changed ? false : ctx.state.appUpdateDismissed
  };
  ctx.notify();
  return nextUpdate;
}

export async function checkAppUpdateAction(ctx) {
  if (ctx.state.mode !== 'cloud') {
    throw new Error('请先连接 Pocket Cloud 后再检查更新');
  }
  const installed = await ensureInstalledAppInfo(ctx);
  const release = await ctx.client.fetchLatestApp();
  const newer = installed && isNewerRelease(installed, release)
    ? release
    : null;
  ctx.state = {
    ...ctx.state,
    appUpdate: newer,
    appUpdateDismissed: false
  };
  ctx.notify();
  return {
    available: Boolean(newer),
    release: newer,
    installed
  };
}

export async function installAppUpdateAction(ctx) {
  const plugin = ctx.updatePlugin;
  if (!plugin || typeof plugin.installAppUpdate !== 'function') {
    throw new Error('当前环境不支持应用内安装 APK');
  }
  const release = ctx.state.appUpdate;
  if (!release?.download_path) {
    throw new Error('暂无可安装的新版本');
  }
  const baseUrl = normalizeBaseUrl(ctx.state.baseUrl);
  const url = `${baseUrl}${release.download_path}`;
  return plugin.installAppUpdate({
    url,
    token: ctx.state.token || '',
    sha256: release.sha256 || '',
    versionName: release.version_name || ''
  });
}

export function dismissAppUpdateAction(ctx) {
  if (!ctx.state.appUpdateDismissed) {
    ctx.state = { ...ctx.state, appUpdateDismissed: true };
    ctx.notify();
  }
}
