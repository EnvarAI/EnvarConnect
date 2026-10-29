import { createHash } from 'node:crypto';
import canonicalizeImport from 'canonicalize';
import { CommerceError } from './errors.js';
const canonicalize = canonicalizeImport as unknown as (data: unknown) => string | undefined;

export function validateUrl(value: string, allowPrivate = false): URL {
  const url = new URL(value);
  if (!['https:', ...(allowPrivate ? ['http:'] : [])].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash) throw new CommerceError('invalid_url', 'Use an HTTP(S) URL without embedded credentials or fragment');
  return url;
}

function assertJson(value: unknown): void {
  if (typeof value === 'number' && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) throw new CommerceError('unsafe_json_number', 'Use strings for integers outside the safe JSON number range');
  if (value === undefined || typeof value === 'function' || typeof value === 'bigint' || typeof value === 'symbol') throw new CommerceError('invalid_json', 'Value must be JSON');
  if (value && typeof value === 'object') {
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new CommerceError('invalid_json', 'Only plain JSON objects are supported');
    for (const child of Object.values(value)) assertJson(child);
  }
}

export function digest(value: unknown): string {
  assertJson(value);
  const serialized = canonicalize(value);
  if (serialized === undefined) throw new CommerceError('invalid_json', 'Cannot canonicalize input');
  return createHash('sha256').update(serialized).digest('hex');
}

