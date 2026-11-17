import { sourceAddress } from './research-sources.js';

/** The renderer submits IDs only. Destinations come from the saved evidence. */
export async function openBriefingItem({ manager, id, itemId, openExternal, openMail }) {
  const record = manager.get(String(id));
  const item = record?.items?.find((entry) => entry.id === String(itemId));
  if (!item) return { ok: false, error: 'That briefing item is no longer available.' };
  try {
    const address = sourceAddress(item.url);
    if (address && !/(?:\.ics$|\/(?:ical|feeds?)(?:\/|$))/i.test(address.pathname)) {
      await openExternal(address.href);
      return { ok: true };
    }
    if (item.kind === 'mail' && typeof item.mailId === 'string' && /^[\da-f]{6,64}$/i.test(item.mailId)) {
      await openMail(item.mailId);
      return { ok: true };
    }
    if (item.kind === 'task') return { ok: true, navigate: 'tasks' };
    if (item.kind === 'event') {
      const at = Number.isFinite(item.start) ? new Date(item.start) : null;
      const sameDay = (entry) => !at || (Number.isFinite(entry.start) && new Date(entry.start).toDateString() === at.toDateString());
      return { ok: true, view: { kind: 'calendar', title: at
        ? `Calendar · ${at.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}` : 'Calendar',
      items: record.items.filter((entry) => entry.kind === 'event' && sameDay(entry)).map(({ title, detail, source, start, end }) => ({ title, detail, source, start, end })) } };
    }
    return { ok: false, error: 'There is no original page available for this item.' };
  } catch { return { ok: false, error: 'That item could not be opened. Please try again.' }; }
}
