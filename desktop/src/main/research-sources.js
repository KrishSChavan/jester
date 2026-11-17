/** Small, safe source records kept with a research answer and its chat history. */
import { webReadAddress } from '../../../jester-extension/src/background/web-reader.js';
import { secretIn } from './vault-memory.js';

const PRIVATE_PARAMETER = /^(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|api[_-]?key|password|secret|auth|authorization|code|session(?:id)?|csrf(?:token)?|signature|sig|x-amz-signature|x-goog-signature)$/i;
const compact = (value, most) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, most) : '';

/** Uses the web reader's address rules, including account actions and private hosts. */
export function sourceAddress(value) {
  if (typeof value !== 'string') return null;
  const url = webReadAddress(value);
  if (!url || [...url.searchParams.keys()].some((key) => PRIVATE_PARAMETER.test(key))) return null;
  // Keep Canvas and other hash routes, but never keep authentication fragments.
  const fragment = url.hash.slice(1);
  const fragmentQuery = fragment.includes('?') ? fragment.slice(fragment.indexOf('?') + 1) : fragment;
  if ([...new URLSearchParams(fragmentQuery).keys()].some((key) => PRIVATE_PARAMETER.test(key))) return null;
  return url;
}

export function sourcesOf(value) {
  if (!Array.isArray(value)) return [];
  const sources = new Map();
  for (const item of value.slice(0, 100)) {
    const address = sourceAddress(item?.url);
    if (!address || sources.has(address.href)) continue;
    const title = compact(item?.title, 200);
    const fetchedAt = compact(item?.fetchedAt, 60);
    const kind = ['page', 'search result'].includes(item?.kind) ? item.kind : '';
    sources.set(address.href, {
      url: address.href,
      title: title && !secretIn(title) ? title : address.hostname,
      ...(fetchedAt && Number.isFinite(Date.parse(fetchedAt)) ? { fetchedAt } : {}),
      ...(kind ? { kind } : {}),
      ...(item?.cited === true ? { cited: true } : {})
    });
    if (sources.size >= 24) break;
  }
  return [...sources.values()];
}
