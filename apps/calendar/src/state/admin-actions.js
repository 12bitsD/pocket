import { CloudRpcError } from '../api/cloud-client.js';
import { deriveAgentGrants } from '../domain/todo-model.js';
import { hasScope } from './sync-reducer.js';

export async function refreshAdminLists(ctx, notify) {
  if (ctx.state.mode !== 'cloud' || !hasScope(ctx.state.identity, '*')) {
    return;
  }
  const [agRes, tkRes] = await Promise.all([
    ctx.client.callRpc('agent.list', {}),
    ctx.client.callRpc('token.list', {})
  ]);
  ctx.state = {
    ...ctx.state,
    agents: agRes.agents || [],
    tokens: tkRes.tokens || []
  };
  notify(ctx);
}

export async function createTokenAction(ctx, spec, notify) {
  if (ctx.state.mode !== 'cloud') {
    throw new CloudRpcError(400, 'DEMO_MODE', 'Connect Pocket Cloud first');
  }
  const created = await ctx.client.callRpc('token.create', {
    kind: spec.kind || 'agent',
    label: spec.label,
    scopes: spec.scopes
  });
  ctx.state = { ...ctx.state, lastMintedToken: created };
  await refreshAdminLists(ctx, notify);
  return created;
}

export async function revokeTokenByIdAction(ctx, tokenId, notify) {
  const res = await ctx.client.callRpc('token.revoke', { token_id: tokenId });
  if (ctx.state.lastMintedToken?.token_id === tokenId) {
    ctx.state = { ...ctx.state, lastMintedToken: null };
  }
  await refreshAdminLists(ctx, notify);
  return res;
}

export async function createPairingAction(ctx, notify) {
  if (ctx.state.mode !== 'cloud') {
    throw new CloudRpcError(400, 'DEMO_MODE', 'Connect Pocket Cloud first');
  }
  const pair = await ctx.client.callRpc('pairing.create', {});
  ctx.state = { ...ctx.state, activePairing: pair };
  notify(ctx);
  return pair;
}

function normalizeAgentDraft(draft) {
  const rawId = String(draft.agentId || draft.agent_id || '')
    .trim()
    .toLowerCase();
  const agentId = rawId.startsWith('@') ? rawId : `@${rawId}`;
  const url = String(draft.endpointUrl || draft.endpoint_url || '').trim();
  const cred = String(draft.credential || '').trim();
  return {
    agent_id: agentId,
    name: String(draft.name || agentId).trim(),
    endpoint_url: url,
    credential: cred || null
  };
}

export async function saveAgentAction(ctx, draft, notify) {
  const spec = normalizeAgentDraft(draft);
  if (ctx.state.mode !== 'cloud') {
    const next = [
      ...ctx.state.agents.filter((a) => a.agent_id !== spec.agent_id),
      {
        agent_id: spec.agent_id,
        name: spec.name,
        endpoint_url: spec.endpoint_url,
        active: true,
        updated_at: ''
      }
    ];
    ctx.state = { ...ctx.state, agents: next };
    notify(ctx);
    return { agent_id: spec.agent_id, active: true };
  }
  const res = await ctx.client.callRpc('agent.set', spec);
  await refreshAdminLists(ctx, notify);
  return res;
}

export async function revokeAgentAction(ctx, agentId, notify) {
  if (ctx.state.mode === 'cloud') {
    await ctx.client.callRpc('agent.revoke', { agent_id: agentId });
    await refreshAdminLists(ctx, notify);
    return;
  }
  ctx.state = {
    ...ctx.state,
    agents: ctx.state.agents.map((a) => (
      a.agent_id === agentId ? { ...a, active: false } : a
    ))
  };
  notify(ctx);
}

function buildGrantScopes(canRead, canWrite) {
  const scopes = [];
  if (canRead) {
    scopes.push('event.read', 'todo.read');
  }
  if (canWrite) {
    scopes.push('event.write', 'todo.write');
  }
  return scopes;
}

function applyDemoScopeGrant(ctx, agentId, scopes, notify) {
  const filtered = ctx.state.tokens.filter((t) => t.label !== agentId);
  if (scopes.length === 0) {
    ctx.state = { ...ctx.state, tokens: filtered };
    notify(ctx);
    return null;
  }
  const demoTok = {
    token_id: `demo_tok_${agentId}`,
    kind: 'agent',
    label: agentId,
    scopes,
    revoked_at: null
  };
  ctx.state = { ...ctx.state, tokens: [...filtered, demoTok] };
  notify(ctx);
  return demoTok;
}

async function runSingleScopeGrant(ctx, agentId, patch, notify) {
  const current = deriveAgentGrants(ctx.state.agents, ctx.state.tokens)
    .find((item) => item.agent_id === agentId);
  const canRead = patch.canRead ?? Boolean(current?.canRead);
  const canWrite = patch.canWrite ?? Boolean(current?.canWrite);
  const scopes = buildGrantScopes(canRead, canWrite);
  if (ctx.state.mode !== 'cloud') {
    return applyDemoScopeGrant(ctx, agentId, scopes, notify);
  }
  const oldIds = current?.tokenIds || [];
  for (const tokenId of oldIds) {
    await ctx.client.callRpc('token.revoke', { token_id: tokenId });
  }
  if (oldIds.includes(ctx.state.lastMintedToken?.token_id)) {
    ctx.state = { ...ctx.state, lastMintedToken: null };
  }
  let minted = null;
  if (scopes.length > 0) {
    minted = await ctx.client.callRpc('token.create', {
      kind: 'agent',
      label: agentId,
      scopes
    });
    ctx.state = { ...ctx.state, lastMintedToken: minted };
  }
  await refreshAdminLists(ctx, notify);
  return minted;
}

export function setAgentScopeGrantAction(ctx, agentId, patch, notify) {
  const next = ctx.grantChain.then(
    () => runSingleScopeGrant(ctx, agentId, patch, notify)
  );
  ctx.grantChain = next.catch(() => null);
  return next;
}
