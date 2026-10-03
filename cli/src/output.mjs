const CONTROLS = /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/gu;
const LABELS = Object.freeze({ accumulation: 'Accumulation', distribution: 'Distribution', event_driven: 'Event driven', elevated_risk: 'Elevated risk', mixed: 'Mixed', quiet: 'Quiet', activist_target: 'Large-holder signal', settlement_stress: 'Settlement stress' });

export function clean(value) { return String(value).replace(CONTROLS, ' '); }
export function json(value) {
  return JSON.stringify(value, null, 2).replace(/[\x7f-\x9f\u202a-\u202e\u2066-\u2069]/gu, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`) + '\n';
}
export function filingLink(raw) {
  try {
    const u = new URL(raw);
    if (u.username || u.password || u.port || !['http:', 'https:'].includes(u.protocol)) return 'no filing link';
    if (u.protocol === 'https:' && u.hostname === 'www.sec.gov' && u.pathname.startsWith('/Archives/edgar/data/')) return clean(u.toString());
    if (['house.gov', 'senate.gov'].some(h => u.hostname === h || u.hostname.endsWith(`.${h}`))) return clean(u.toString());
  } catch { /* A missing or malformed filing URL is absence, not a source. */ }
  return 'no filing link';
}

function readable(key, value) {
  if (value === null) return /(?:url|link)$/i.test(key) ? 'no filing link' : 'null';
  if (typeof value === 'string') {
    if (/(?:url|link)$/i.test(key)) return filingLink(value);
    if (['state', 'overall_state', 'structural_state'].includes(key)) return clean(LABELS[value] ?? value);
    return clean(value);
  }
  if (Array.isArray(value)) return value.map(v => readable(key, v));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [clean(k), readable(k, v)]));
  return value;
}

function fields(value) {
  if (value === null || typeof value !== 'object') return `value\t${value === null ? 'null' : clean(value)}\n`;
  return Object.entries(value).map(([k, v]) => {
    const r = readable(k, v);
    return `${clean(k)}\t${typeof r === 'object' && r !== null ? JSON.stringify(r) : r}`;
  }).join('\n') + '\n';
}

export function render(result, format) {
  if (format === 'json') return json(result);
  const { data, meta, client } = result;
  const rows = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : null;
  let text = 'Field\tValue\n';
  if (rows) {
    text += `${rows.length} rows in this bounded response.\n`;
    for (const [i, row] of rows.entries()) text += `\nRecord ${i + 1}\n${fields(row)}`;
    if (!Array.isArray(data)) text += '\nPage\n' + fields(Object.fromEntries(Object.entries(data).filter(([k]) => k !== 'items' && k !== 'next_cursor')));
  } else text += fields(data);
  text += '\nMetadata\n' + fields(meta);
  if (client?.continuation) text += `\nContinuation (same filters and limit)\n${client.continuation}\n`;
  return text;
}
