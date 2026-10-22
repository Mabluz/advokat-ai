/**
 *   npm run search -- "deling av bolig ved skilsmisse"
 *   npm run search -- --lov tvisteloven "foreldelse"
 *   npm run search -- --paragraf TEK17 12-7
 */
import { formatChunk, getParagraph, search } from "./search.js";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};

const para = flag("paragraf");
if (para) {
  const { doc, parts } = await getParagraph(para, args.join(" "));
  console.log(doc ? (parts.length ? parts.map((p) => formatChunk(p)).join("\n\n---\n\n") : "Fant ikke paragrafen") : "Ukjent lov");
} else {
  const lov = flag("lov");
  const antall = Number(flag("antall") ?? 5);
  const { hits } = await search(args.join(" "), { lov, antall });
  for (const [i, h] of hits.entries()) {
    const body = formatChunk(h.payload, i + 1);
    console.log(`${body.length > 900 ? `${body.slice(0, 900)} …` : body}\n\n---\n`);
  }
}
