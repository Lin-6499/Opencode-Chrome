import { timingSafeEqual } from 'node:crypto';

export function isAuthorized(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

export function isExtensionOrigin(origin) {
  return typeof origin === 'string' && /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
}
