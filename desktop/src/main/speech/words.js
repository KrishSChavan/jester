/**
 * Comparing what was heard with what was meant, word by word.
 */

const SMALL = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const spell = (n) => (n < 20 ? SMALL[n] : n < 100 ? `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${SMALL[n % 10]}` : ''}` : String(n));

/** Lowercase words without punctuation, with numbers spelled out: "30%" → "thirty percent". */
export function words(text) {
  return String(text)
    .toLowerCase()
    .replace(/%/g, ' percent')
    .replace(/\d+/g, (digits) => ` ${spell(Number(digits))} `)
    .replace(/[^a-z' ]+/g, ' ')
    .replace(/'/g, '')
    .split(/\s+/)
    .filter(Boolean);
}

/** Word error rate: edits (substitutions, insertions, deletions) per reference word. */
export function wer(reference, hypothesis) {
  const ref = words(reference);
  const hyp = words(hypothesis);
  const row = Array.from({ length: hyp.length + 1 }, (_, j) => j);
  for (let i = 1; i <= ref.length; i++) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= hyp.length; j++) {
      const above = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (ref[i - 1] === hyp[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return ref.length ? row[hyp.length] / ref.length : hyp.length ? 1 : 0;
}

/** Same words once spaces are ignored: "lo fi" and "lofi", "mr beast" and "mrbeast". */
export const sameWords = (a, b) => words(a).join('') === words(b).join('');
