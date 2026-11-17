/** Research progress and the pages behind an answer. Opening a page is always
 * an explicit click; scraped titles are text and never become page markup. */
export function researchSources(sources) {
  const seen = new Set();
  const kept = [];
  for (const source of Array.isArray(sources) ? sources : []) {
    let url;
    try { url = new URL(source?.url); } catch { continue; }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.href.length > 4096 || seen.has(url.href)) continue;
    seen.add(url.href);
    kept.push({ url: url.href, title: typeof source.title === 'string' && source.title.trim() ? source.title.replace(/\s+/g, ' ').trim().slice(0, 300) : url.hostname,
      domain: url.hostname.replace(/^www\./, ''), fetchedAt: typeof source.fetchedAt === 'string' ? source.fetchedAt.slice(0, 60) : '' });
    if (kept.length >= 24) break;
  }
  return kept;
}

const openSource = (url) => chrome.runtime.sendMessage({ type: 'jester/research', op: 'open', url });
const stopResearch = () => chrome.runtime.sendMessage({ type: 'jester/research', op: 'stop' });

function sourceElement(source, document, open) {
  const card = document.createElement('article');
  card.className = 'research-source';
  const words = document.createElement('div');
  words.className = 'research-source-words';
  const domain = document.createElement('span');
  domain.className = 'research-source-domain';
  domain.textContent = source.domain;
  const title = document.createElement('strong');
  title.className = 'research-source-title';
  title.textContent = source.title;
  words.append(domain, title);
  if (source.fetchedAt) card.title = `Retrieved ${source.fetchedAt}`;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'research-source-open';
  button.textContent = 'Open';
  button.setAttribute('aria-label', `Open ${source.title}`);
  const error = document.createElement('span');
  error.className = 'research-source-error';
  error.setAttribute('role', 'status');
  error.hidden = true;
  button.addEventListener('click', async () => {
    if (button.disabled) return;
    button.disabled = true;
    error.hidden = true;
    try {
      const result = await open(source.url);
      if (result?.ok === false) throw new Error('not opened');
    } catch {
      error.textContent = 'Couldn’t open this page. Try again.';
      error.hidden = false;
    } finally { button.disabled = false; }
  });
  words.append(error);
  card.append(words, button);
  return card;
}

/** Up to three cards are shown. A longer collection starts collapsed. */
export function sourceCardsElement(sources, { document = globalThis.document, open = openSource } = {}) {
  const list = researchSources(sources);
  if (!list.length) return null;
  const dropdown = list.length > 3;
  const section = document.createElement(dropdown ? 'details' : 'div');
  section.className = `research-sources${dropdown ? ' research-dropdown' : ''}`;
  const heading = document.createElement(dropdown ? 'summary' : 'h3');
  heading.className = 'research-sources-heading';
  heading.textContent = dropdown ? `${list.length} sources` : 'Sources';
  if (!dropdown) {
    section.setAttribute('role', 'group');
    section.setAttribute('aria-label', 'Sources');
  }
  const cards = document.createElement('div');
  cards.className = 'research-source-list';
  cards.append(...list.map((source) => sourceElement(source, document, open)));
  section.append(heading, cards);
  return section;
}

/** Stable contents avoid announcing the same progress on every state tick. */
export function renderResearchState(container, research, document = container.ownerDocument, stop = stopResearch) {
  const active = research?.active === true;
  const detail = typeof research?.label === 'string' ? research.label.replace(/\s+/g, ' ').trim().slice(0, 180) : '';
  const score = Number.isFinite(research?.scrapeConfidence) ? Math.round(Math.max(0, Math.min(100, research.scrapeConfidence))) : null;
  const reason = typeof research?.strategyReason === 'string' ? research.strategyReason.slice(0, 300) : '';
  const planning = research?.phase === 'routing';
  const key = active ? `active:${planning}:${detail}:${score}:${reason}` : '';
  container.hidden = !active;
  container.setAttribute('aria-busy', String(active));
  if (container.dataset.researchKey === key) return;
  container.dataset.researchKey = key;
  container.replaceChildren();
  if (!active) return;
  const indicator = document.createElement('span');
  indicator.className = 'research-spinner';
  indicator.setAttribute('aria-hidden', 'true');
  const words = document.createElement('span');
  words.className = 'research-progress-words';
  const title = document.createElement('strong');
  title.textContent = planning ? 'Planning your search' : 'Searching the internet';
  words.append(title);
  if (detail && !/^searching the internet[.…]*$/i.test(detail)) {
    const step = document.createElement('span');
    step.className = 'research-progress-detail';
    step.textContent = detail;
    words.append(step);
  }
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'research-stop';
  button.textContent = 'Stop';
  button.setAttribute('aria-label', 'Stop searching');
  button.addEventListener('click', async () => {
    if (button.disabled) return;
    button.disabled = true;
    try { await stop(); } catch { /* Progress continues to report its actual state. */ }
    finally { button.disabled = false; }
  });
  container.append(indicator, words);
  if (score !== null) {
    const confidence = document.createElement('span');
    confidence.className = 'research-confidence';
    confidence.textContent = `${score}/100`;
    confidence.title = `Scraping confidence: ${score}/100${reason ? ` — ${reason}` : ''}`;
    confidence.setAttribute('aria-label', confidence.title);
    container.append(confidence);
  }
  container.append(button);
}
