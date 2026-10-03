import { ORIGIN } from './commands.mjs';
import { CliError, cancelled, responseError, remoteError } from './errors.mjs';

export const MAX_BODY = 16 * 1024 * 1024;
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const count = v => Number.isSafeInteger(v) && v >= 0;

export function validateResponse(spec, value) {
  if (!object(value) || !Object.hasOwn(value, 'data') || !object(value.meta) || Object.hasOwn(value, 'error')) throw responseError();
  const pending = [[value, 0]];
  while (pending.length) {
    const [v, depth] = pending.pop();
    if (depth > 64 || (typeof v === 'number' && !Number.isFinite(v))) throw responseError();
    if (v !== null && typeof v === 'object') for (const x of Object.values(v)) pending.push([x, depth + 1]);
  }
  for (const k of ['count', 'matched_count']) if (Object.hasOwn(value.meta, k) && !count(value.meta[k])) throw responseError();
  const d = value.data;
  const rows = list => { if (!Array.isArray(list) || list.some(v => !object(v))) throw responseError(); };
  const identity = row => {
    if (typeof row.entity_id !== 'string' || !row.entity_id || typeof row.symbol !== 'string' || !row.symbol) throw responseError();
  };
  switch (spec.command) {
    case 'catalog':
      if (!object(d) || !Array.isArray(d.routes) || !Array.isArray(d.tools) || typeof d.api_base !== 'string' || typeof d.mcp_endpoint !== 'string') throw responseError();
      rows(d.routes); rows(d.tools); break;
    case 'search': rows(d); for (const r of d) identity(r); break;
    case 'ticker': case 'demo': case 'consensus':
      if (!object(d)) throw responseError(); identity(d);
      if (!object(d.dimensions)) throw responseError(); break;
    case 'rating': if (d !== null && !object(d)) throw responseError(); break;
    case 'evidence': if (!object(d)) throw responseError(); break;
    case 'screen':
      if (!object(d) || !count(d.matched_count) || typeof d.has_more !== 'boolean') throw responseError();
      rows(d.items); for (const r of d.items) identity(r); break;
    case 'events': if (!object(d)) throw responseError(); rows(d.items); break;
    case 'notices':
      if (!object(d) || !object(d.coverage)) throw responseError();
      rows(d.items);
      if (!(d.next_cursor === null || typeof d.next_cursor === 'string')) throw responseError(); break;
    default:
      if (!spec.command.startsWith('feed ') || !object(d) || !count(d.count) || !count(d.matched_count) || !(d.next_cursor === null || typeof d.next_cursor === 'string')) throw responseError();
      rows(d.items);
      for (const row of d.items) if (typeof row.event_id !== 'string' || !row.event_id) throw responseError();
      if (d.count !== d.items.length) throw responseError();
  }
  return value;
}

function retryHint(headers, value) {
  const hint = {};
  const raw = headers.get('retry-after');
  if (raw && /^\d{1,5}$/.test(raw) && Number(raw) <= 86400) hint.retry_after_seconds = Number(raw);
  else if (raw && /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(raw)) {
    const seconds = Math.ceil((Date.parse(raw) - Date.now()) / 1000);
    if (Number.isFinite(seconds) && seconds >= 0 && seconds <= 86400) hint.retry_after_seconds = seconds;
  }
  const reset = value?.error?.resets_at;
  if (typeof reset === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(reset)) {
    const time = Date.parse(reset);
    if (Number.isFinite(time) && new Date(time).toISOString() === reset && time >= Date.now() - 1000 && time <= Date.now() + 86400000) hint.resets_at = reset;
  }
  return Object.keys(hint).length ? hint : undefined;
}

export async function request(spec, key, { fetcher = fetch, signal, deadline = 10000 } = {}) {
  const url = new URL(spec.url);
  if (url.origin !== ORIGIN || url.protocol !== 'https:' || url.username || url.password) throw responseError();
  const controller = new AbortController();
  let timedOut = false;
  let reader;
  const onAbort = () => controller.abort();
  if (signal?.aborted) throw cancelled();
  signal?.addEventListener('abort', onAbort, { once: true });
  let timer;
  let rejectStop;
  const stop = new Promise((_, reject) => { rejectStop = reject; });
  const onStopped = () => rejectStop(timedOut ? new CliError('timeout', 'The API request timed out.', 6) : cancelled());
  controller.signal.addEventListener('abort', onStopped, { once: true });
  timer = setTimeout(() => { timedOut = true; controller.abort(); }, deadline);
  try {
    const headers = { Accept: 'application/json' };
    if (!spec.keyless) headers.Authorization = `Bearer ${key}`;
    const res = await Promise.race([fetcher(url.toString(), { method: 'GET', headers, redirect: 'error', signal: controller.signal }), stop]);
    if (res.status >= 300 && res.status < 400) throw new CliError('redirect_refused', 'The API redirected the request; no redirect was followed.', 6, res.status);
    if (!res.body) throw responseError();
    reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await Promise.race([reader.read(), stop]);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) throw responseError();
      chunks.push(value);
    }
    let body;
    try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))); }
    catch { if (res.ok) throw responseError(); }
    if (!res.ok) throw remoteError(res.status, body?.error?.code, res.status === 429 ? retryHint(res.headers, body) : undefined);
    return validateResponse(spec, body);
  } catch (e) {
    if (e instanceof CliError) throw e;
    if (controller.signal.aborted) throw timedOut ? new CliError('timeout', 'The API request timed out.', 6) : cancelled();
    throw new CliError('network_error', 'The API could not be reached securely.', 6);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    controller.signal.removeEventListener('abort', onStopped);
    controller.abort();
    if (reader) reader.cancel().catch(() => {});
  }
}
