export const STATUSES = ['pending', 'ok', 'failed', 'needs-agent', 'todo'];
export const COLLECTORS = ['tools', 'secrets', 'claude', 'projects', 'shell', 'services']; // also the import order

export function makeItem({ id, collector, kind, title, data = {}, size = 0, status = 'pending', reason = null }) {
  if (!id) throw new Error('item id required');
  if (!COLLECTORS.includes(collector)) throw new Error(`unknown collector: ${collector}`);
  if (!STATUSES.includes(status)) throw new Error(`unknown status: ${status}`);
  return { id, collector, kind, title, size, status, reason, data };
}

export function withStatus(item, status, reason = null) {
  if (!STATUSES.includes(status)) throw new Error(`unknown status: ${status}`);
  if ((status === 'failed' || status === 'needs-agent') && !reason) throw new Error(`reason required for ${status}`);
  return { ...item, status, reason };
}

export function summarize(items) {
  const out = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const it of items) out[it.status] += 1;
  return out;
}
