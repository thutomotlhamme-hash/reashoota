// Account/cloud backup. When signed in, every saved project is queued and pushed to the
// ReaShoota backend as a full bundle; the phone copy is always kept too. The queue lives on
// the device, so edits made with no signal upload automatically when the connection returns.
//
// Backend contract (JSON, Bearer auth):
//   GET  {endpoint}/projects            -> [{ id, name, updatedAt }]
//   GET  {endpoint}/projects/:id        -> bundle (see backup.js)
//   PUT  {endpoint}/projects/:id        <- bundle

import { getKV, setKV } from './store.js';

const CONFIG_KEY = 'cloud-config';
const QUEUE_KEY = 'cloud-queue';

export async function getCloudConfig() {
  return getKV(CONFIG_KEY, null);
}

export async function signIn({ endpoint, token, email }) {
  const cfg = { endpoint: endpoint.replace(/\/+$/, ''), token, email };
  await request(cfg, 'GET', '/projects'); // validates the credentials
  await setKV(CONFIG_KEY, cfg);
  return cfg;
}

export async function signOut() {
  await setKV(CONFIG_KEY, null);
}

async function request(cfg, method, path, body) {
  const res = await fetch(`${cfg.endpoint}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Cloud ${method} ${path} failed (${res.status})`);
  return res.status === 204 ? null : res.json();
}

export async function queueProject(id) {
  const q = new Set(await getKV(QUEUE_KEY, []));
  q.add(id);
  await setKV(QUEUE_KEY, [...q]);
}

export async function pendingCount() {
  return (await getKV(QUEUE_KEY, [])).length;
}

// buildBundleFor(id) -> bundle | null (null = project deleted locally; drop from queue)
export async function flushQueue(buildBundleFor) {
  const cfg = await getCloudConfig();
  if (!cfg || !navigator.onLine) return { pushed: 0, pending: await pendingCount() };
  const queue = await getKV(QUEUE_KEY, []);
  let pushed = 0;
  const remaining = [];
  for (const id of queue) {
    try {
      const bundle = await buildBundleFor(id);
      if (bundle) { await request(cfg, 'PUT', `/projects/${encodeURIComponent(id)}`, bundle); pushed += 1; }
    } catch {
      remaining.push(id);
    }
  }
  await setKV(QUEUE_KEY, remaining);
  return { pushed, pending: remaining.length };
}

export async function listRemote() {
  const cfg = await getCloudConfig();
  if (!cfg) return [];
  return request(cfg, 'GET', '/projects');
}

export async function fetchRemote(id) {
  const cfg = await getCloudConfig();
  if (!cfg) throw new Error('Not signed in');
  return request(cfg, 'GET', `/projects/${encodeURIComponent(id)}`);
}
