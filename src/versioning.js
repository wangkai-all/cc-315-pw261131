import { createHash } from 'node:crypto';

/** Canonical JSON: object keys sorted recursively, undefined omitted. */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map((v) => stableStringify(v)).join(',') + ']';
  }
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Short content-addressed version label, e.g. dem-1a2b3c4d5e. */
export function versionOf(value, prefix, length = 10) {
  return `${prefix}-${sha256(stableStringify(value)).slice(0, length)}`;
}

export const MODEL_CODE_VERSION = 'huff-capacity-v1';

export const INPUT_KEYS = ['demand', 'network', 'stores', 'candidates', 'history', 'model'];

export function versionKey(versions) {
  return sha256(stableStringify(Object.fromEntries(INPUT_KEYS.map((k) => [k, versions[k] ?? null])))).slice(0, 16);
}

export function diffVersions(a, b) {
  const out = [];
  for (const key of [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])].sort()) {
    if ((a?.[key] ?? null) !== (b?.[key] ?? null)) {
      out.push({ key, previous: a?.[key] ?? null, current: b?.[key] ?? null });
    }
  }
  return out;
}

export function isStale(scenarioInputs, activeInputs) {
  return INPUT_KEYS.some((k) => (scenarioInputs?.[k] ?? null) !== (activeInputs?.[k] ?? null));
}
