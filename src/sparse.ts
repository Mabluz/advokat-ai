/**
 * Client-side sparse vectors for keyword (BM25) search. Qdrant applies IDF
 * (collection sparse vector configured with modifier "idf"); we provide the
 * BM25 term-frequency component here.
 */

const STOPWORDS = new Set(
  ("og i jeg det at en et den til er som på de med han av ikke der så var meg seg men ett har om vi min mitt ha hadde " +
    "hun nå over da ved fra du ut sin dem oss opp man kan hans hvor eller hva skal selv sjøl her alle vil bli ble blitt " +
    "kunne inn når være kom noen noe ville dere deg si sine sitt mot å hvis din ditt deres for af eit ei dei ikkje")
    .split(" "),
);

const K1 = 1.2;
const B = 0.75;
const AVG_LEN = 120;

export function tokenize(text: string): string[] {
  const tokens = text.toLowerCase().match(/§|[\p{L}\p{N}]+(?:-[\p{N}]+[a-z]?)*/gu) ?? [];
  return tokens.filter((t) => t === "§" || /^\d$/.test(t) || (t.length > 1 && !STOPWORDS.has(t)));
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export interface SparseVector {
  indices: number[];
  values: number[];
}

function toSparse(counts: Map<number, number>, value: (tf: number) => number): SparseVector {
  const indices = [...counts.keys()].sort((a, b) => a - b);
  return { indices, values: indices.map((i) => value(counts.get(i)!)) };
}

function count(tokens: string[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const t of tokens) {
    const h = fnv1a(t);
    counts.set(h, (counts.get(h) ?? 0) + 1);
  }
  return counts;
}

export function sparseDoc(text: string): SparseVector {
  const tokens = tokenize(text);
  const norm = K1 * (1 - B + (B * tokens.length) / AVG_LEN);
  return toSparse(count(tokens), (tf) => (tf * (K1 + 1)) / (tf + norm));
}

export function sparseQuery(text: string): SparseVector {
  return toSparse(count(tokenize(text)), () => 1);
}
