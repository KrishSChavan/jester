/** Policy is enforced by the worker before observations and every action. */
export const PERMISSION_BOUNDARIES = {
  ask: { label: 'Ask before every action', hint: 'Approve each click, keystroke, tab change, playback control and navigation: say yes or no, or use the toolbar popup.' },
  entertainment: { label: 'Ask before sensitive actions', hint: 'Allow browsing, search, tabs and playback on any site. Ask before purchases, sending, posting, deleting, sign-in or account pages, and typing outside search boxes.' },
  site: { label: 'Never ask', hint: 'Allow every supported action on any site without asking, subject to Chrome site permissions.' }
};
/**
 * A page a task may open, follow a link to, or act on: an ordinary web page on
 * any site. Chrome's own pages, files and scripts never are.
 */
export function webPage(url) {
  try { return /^https?:$/.test(new URL(url).protocol); } catch { return false; }
}
export function requiresConfirmation(boundary, category) {
  if (!Object.hasOwn(PERMISSION_BOUNDARIES, boundary) || !['read','browse','sensitive'].includes(category)) return true;
  return category !== 'read' && (boundary === 'ask' || (boundary === 'entertainment' && category === 'sensitive'));
}
