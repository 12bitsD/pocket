import { CloudRpcError } from '../api/cloud-client.js';
import {
  claimPairingSession,
  fetchCloudSnapshot
} from './cloud-session.js';
import { reapplyOfflineOverlay } from './offline-flush.js';

function extractPairFields(url, code) {
  const cleanUrl = String(url || '').trim();
  const cleanCode = String(code || '').trim();
  if (!cleanUrl || !/^\d{6}$/.test(cleanCode)) {
    return null;
  }
  return { baseUrl: cleanUrl, code: cleanCode };
}

function parseJsonPairPayload(clean) {
  let obj = null;
  try {
    obj = JSON.parse(clean);
  } catch {
    obj = null;
  }
  return obj ? extractPairFields(obj.url || obj.baseUrl, obj.code) : null;
}

export function parsePairingQrPayload(rawText) {
  const clean = String(rawText || '').trim();
  if (!clean) {
    return null;
  }
  if (clean.startsWith('{')) {
    return parseJsonPairPayload(clean);
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(clean)) {
    return null;
  }
  let parsed = null;
  try {
    parsed = new URL(clean);
  } catch {
    parsed = null;
  }
  if (!parsed) {
    return null;
  }
  return extractPairFields(
    parsed.searchParams.get('url'),
    parsed.searchParams.get('code')
  );
}

export async function claimPairUriAction(ctx, rawUri, deviceName) {
  const parsed = parsePairingQrPayload(rawUri);
  if (!parsed) {
    throw new CloudRpcError(422, 'INVALID_PAIR_QR', '无效的配对二维码内容');
  }
  return claimPairingSession(ctx, {
    baseUrl: parsed.baseUrl,
    code: parsed.code,
    name: deviceName || 'Pocket Phone'
  });
}

export async function scanAndClaimPairingAction(ctx, deviceName) {
  const plugin = globalThis?.Capacitor?.Plugins?.PocketAlarm;
  if (!plugin?.scanPairingQr) {
    throw new CloudRpcError(400, 'SCAN_UNAVAILABLE', '当前环境不支持调用扫码');
  }
  const scan = await plugin.scanPairingQr();
  if (scan?.cancelled || !scan?.raw) {
    return { cancelled: true };
  }
  const claimed = await claimPairUriAction(ctx, scan.raw, deviceName);
  return { cancelled: false, claimed };
}

function replaceIntegrationItem(list, updated) {
  const items = Array.isArray(list) ? list : [];
  const next = items.filter((item) => item.provider !== updated.provider);
  return [...next, updated];
}

export async function refreshIntegrationsAction(ctx) {
  if (ctx.state.mode !== 'cloud') {
    return [];
  }
  const res = await ctx.client.callRpc('integration.list', {});
  const integrations = res.integrations || [];
  ctx.state = { ...ctx.state, integrations };
  ctx.notify();
  return integrations;
}

export async function configureFeishuAction(ctx, spec) {
  if (ctx.state.mode !== 'cloud') {
    throw new CloudRpcError(400, 'DEMO_MODE', '请先连接 Pocket Cloud');
  }
  const updated = await ctx.client.callRpc('integration.feishu.configure', {
    app_id: String(spec?.appId || '').trim(),
    app_secret: String(spec?.appSecret || '').trim()
  });
  ctx.state = {
    ...ctx.state,
    integrations: replaceIntegrationItem(ctx.state.integrations, updated)
  };
  ctx.notify();
  return updated;
}

export async function startFeishuOAuthAction(ctx) {
  if (ctx.state.mode !== 'cloud') {
    throw new CloudRpcError(400, 'DEMO_MODE', '请先连接 Pocket Cloud');
  }
  const res = await ctx.client.callRpc('integration.feishu.auth_url', {});
  const url = String(res?.auth_url || '');
  const plugin = globalThis?.Capacitor?.Plugins?.PocketAlarm;
  if (url && plugin?.openExternalUrl) {
    await plugin.openExternalUrl({ url });
  } else if (url && typeof window !== 'undefined' && window.open) {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
  return res;
}

export async function syncFeishuNowAction(ctx) {
  if (ctx.state.mode !== 'cloud') {
    throw new CloudRpcError(400, 'DEMO_MODE', '请先连接 Pocket Cloud');
  }
  const stats = await ctx.client.callRpc('integration.feishu.sync', {});
  const snap = await fetchCloudSnapshot(ctx, ctx.state.identity);
  ctx.state = reapplyOfflineOverlay({ ...ctx.state, ...snap });
  ctx.notify();
  return stats;
}

export async function unbindFeishuAction(ctx) {
  if (ctx.state.mode !== 'cloud') {
    throw new CloudRpcError(400, 'DEMO_MODE', '请先连接 Pocket Cloud');
  }
  const updated = await ctx.client.callRpc('integration.feishu.unbind', {});
  ctx.state = {
    ...ctx.state,
    integrations: replaceIntegrationItem(ctx.state.integrations, updated)
  };
  ctx.notify();
  return updated;
}
