/** Render only text and validated links; scraped/model text is never HTML. */
export function renderResearchResult(card, result, document = card.ownerDocument) {
  card.replaceChildren();
  card.hidden = !result || typeof result.text !== 'string' || !result.text.trim();
  if (card.hidden) return;
  const summary = document.createElement('summary');
  summary.textContent = 'Research results';
  const answer = document.createElement('p');
  answer.className = 'research-answer small';
  answer.textContent = result.text.slice(0, 16000);
  card.append(summary, answer);
  const sources = document.createElement('ul');
  sources.className = 'research-sources small';
  for (const source of (Array.isArray(result.sources) ? result.sources : []).slice(0, 8)) {
    let url;
    try { url = new URL(source?.url); } catch { continue; }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.href.length > 4096) continue;
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.href = url.href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = String(source.title || url.href).slice(0, 300);
    link.title = url.href;
    item.append(link);
    const address = document.createElement('span');
    address.className = 'muted';
    address.textContent = url.href;
    item.append(address);
    if (typeof source.fetchedAt === 'string' && source.fetchedAt) {
      const stamp = document.createElement('span');
      stamp.className = 'muted';
      stamp.textContent = `Retrieved ${source.fetchedAt.slice(0, 60)}`;
      item.append(stamp);
    }
    sources.append(item);
  }
  if (sources.children.length) card.append(sources);
}
