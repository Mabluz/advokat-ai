import { readFile } from "node:fs/promises";
import type { ChunkPayload } from "./chunk.js";
import { DOCS_FILE, DOMMER_COLLECTION } from "./config.js";
import type { DomPayload } from "./dommer/parse.js";
import { embed } from "./embed.js";
import { normalisePara } from "./lovdata/parse.js";
import { countPoints, hybridSearch, scrollAll, type Condition } from "./qdrant.js";
import { sparseQuery } from "./sparse.js";
import type { CatalogEntry } from "./sync.js";

let catalog: CatalogEntry[] | undefined;

export async function loadCatalog(): Promise<CatalogEntry[]> {
  if (!catalog) catalog = JSON.parse(await readFile(DOCS_FILE, "utf8")) as CatalogEntry[];
  return catalog;
}

const lc = (s?: string) => (s ?? "").toLowerCase().trim();

/** Ranks catalog entries against a free-text law name ("ekteskapsloven", "tvl", "TEK17", "LOV-2005-06-17-90"). */
export async function findDocs(query: string, limit = 10): Promise<CatalogEntry[]> {
  const q = lc(query).replace(/^(lov|forskrift)\//, "");
  const scored: [number, CatalogEntry][] = [];
  for (const d of await loadCatalog()) {
    const kort = lc(d.korttittel);
    const fork = lc(d.forkortelse);
    let score = 0;
    if (lc(d.dokId) === q || lc(d.refId).endsWith(q)) score = 100;
    else if (kort === q || fork === q) score = 90;
    else if (kort.replace(/\s*\(.*\)$/, "") === q) score = 85;
    else if (kort.startsWith(q)) score = 70;
    else if (kort.includes(q)) score = 50;
    else if (lc(d.tittel).includes(q)) score = 40;
    if (!score) continue;
    // prefer laws over regulations and in-force documents over amendment acts
    if (d.type === "lov") score += 3;
    if (d.endringsdokument) score -= 20;
    // parallel nynorsk version (Grunnlova): only when asked for by name
    if (d.parallellversjon) score -= 2;
    scored.push([score, d]);
  }
  return scored
    .sort((a, b) => b[0] - a[0] || a[1].korttittel.length - b[1].korttittel.length)
    .slice(0, limit)
    .map(([, d]) => d);
}

export async function resolveDoc(query: string): Promise<CatalogEntry | undefined> {
  return (await findDocs(query, 1))[0];
}

export interface SearchOptions {
  lov?: string;
  type?: ChunkPayload["type"];
  inkluderEndringsdokumenter?: boolean;
  antall?: number;
}

export async function search(sporsmal: string, opts: SearchOptions = {}) {
  const must: Condition[] = [];
  let resolved: CatalogEntry | undefined;
  if (opts.lov) {
    resolved = await resolveDoc(opts.lov);
    if (!resolved) throw new Error(`Fant ingen lov/forskrift som matcher «${opts.lov}». Bruk list_lover.`);
    must.push({ key: "dok_id", match: { value: resolved.dokId } });
  }
  if (opts.type) must.push({ key: "type", match: { value: opts.type } });
  if (!opts.inkluderEndringsdokumenter && !resolved?.endringsdokument) {
    must.push({ key: "endringsdokument", match: { value: false } });
  }
  const [dense] = await embed([sporsmal]);
  const hits = await hybridSearch(dense, sparseQuery(sporsmal), opts.antall ?? 8, must.length ? { must } : undefined);
  return { resolved, hits };
}

export async function getParagraph(lov: string, paragraf: string) {
  const doc = await resolveDoc(lov);
  if (!doc) return { doc, parts: [] as ChunkPayload[] };
  const parts = await scrollAll({
    must: [
      { key: "dok_id", match: { value: doc.dokId } },
      { key: "paragraf_norm", match: { value: normalisePara(paragraf) } },
    ],
  });
  return { doc, parts };
}

export async function getDocument(lov: string, kapittel?: string) {
  const doc = await resolveDoc(lov);
  if (!doc) return { doc, parts: [] as ChunkPayload[] };
  let parts = await scrollAll({ must: [{ key: "dok_id", match: { value: doc.dokId } }] });
  if (kapittel) {
    // "12" means "Kapittel 12" (but not "Kapittel 120"); anything else is matched as a whole phrase
    const k = lc(kapittel).replace(/^kap\.?\s*/, "kapittel ");
    const needle = /^\d+\s?[a-z]?$/.test(k) ? `kapittel ${k}` : k;
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}\\p{N}])`, "iu");
    parts = parts.filter((p) => p.kapittel.some((c) => re.test(c)));
  }
  return { doc, parts };
}

const today = () => new Date().toISOString().slice(0, 10);

export function docStatus(p: Pick<ChunkPayload, "i_kraft_fra" | "endringsdokument">): string[] {
  const notes: string[] = [];
  if (p.i_kraft_fra && p.i_kraft_fra > today()) notes.push(`⚠ IKKE I KRAFT før ${p.i_kraft_fra}`);
  if (p.endringsdokument) notes.push("⚠ ENDRINGSDOKUMENT (endrer/opphever andre regler – ikke selvstendig gjeldende tekst)");
  return notes;
}

export function formatChunk(p: ChunkPayload, index?: number): string {
  const name = p.forkortelse && !p.korttittel.includes(p.forkortelse) ? `${p.korttittel} (${p.forkortelse})` : p.korttittel;
  const head = [
    `${index !== undefined ? `[${index}] ` : ""}${name} ${p.paragraf}${p.overskrift ? ` ${p.overskrift}` : ""}${p.del ? ` (del ${p.del})` : ""}`,
    `${p.tittel} – ${p.dok_id}${p.kapittel.length ? ` – ${p.kapittel.join(" > ")}` : ""}`,
    p.url,
    ...docStatus(p),
  ];
  const tail = p.endringshistorikk ? `\n(Lovdata: ${p.endringshistorikk})` : "";
  return `${head.join("\n")}\n\n${p.tekst}${tail}`;
}

export function formatDocMeta(d: CatalogEntry): string {
  return [
    `${d.korttittel}${d.forkortelse && !d.korttittel.includes(d.forkortelse) ? ` (${d.forkortelse})` : ""} – ${d.tittel}`,
    `${d.dokId} | ${d.type}${d.endringsdokument ? " (endringsdokument)" : ""} | i kraft fra ${d.iKraftFra ?? "ukjent"}${d.sisteEndringIKraft ? ` | siste endring i kraft ${d.sisteEndringIKraft}` : ""}`,
    d.departement.length ? `Departement: ${d.departement.join(", ")}` : "",
    d.hjemmel ? `Hjemmel: ${d.hjemmel}` : "",
    d.url,
    ...docStatus({ i_kraft_fra: d.iKraftFra, endringsdokument: d.endringsdokument }),
  ]
    .filter(Boolean)
    .join("\n");
}

// ---- Rettspraksis (court decisions saved by the user in dommer/) ----

/** Best passages grouped per decision (in fused rank order), so one long judgment cannot crowd out the others. */
export async function searchDecisions(sporsmal: string, antall = 6, perDom = 2) {
  if (!(await countPoints(DOMMER_COLLECTION))) return [];
  const [dense] = await embed([sporsmal]);
  const ranked = await hybridSearch<DomPayload>(dense, sparseQuery(sporsmal), 200, undefined, DOMMER_COLLECTION);
  const groups = new Map<string, typeof ranked>();
  for (const hit of ranked) {
    const g = groups.get(hit.payload.saksnummer);
    if (g) {
      if (g.length < perDom) g.push(hit);
    } else if (groups.size < antall) {
      groups.set(hit.payload.saksnummer, [hit]);
    }
  }
  return [...groups.values()].flat();
}

export async function getDecision(saksnummer: string): Promise<DomPayload[]> {
  if (!(await countPoints(DOMMER_COLLECTION))) return [];
  // accepts "HR-2010-1433-U", "Rt-2010-972" and "Rt. 2010 s. 972"
  const q = saksnummer.trim().replace(/^Rt\.?\s*(\d{4})\s*s\.?\s*(\d+)$/i, "Rt-$1-$2");
  const value = /^rt-/i.test(q) ? `Rt-${q.slice(3)}` : q.toUpperCase();
  return scrollAll<DomPayload>(
    { should: [{ key: "saksnummer", match: { value } }, { key: "rt_ref", match: { value } }] },
    10000,
    DOMMER_COLLECTION,
  );
}

export function formatDecision(p: DomPayload, index?: number): string {
  const head = [
    `${index !== undefined ? `[${index}] ` : ""}${[p.saksnummer, p.rt_ref].filter(Boolean).join(" / ")} – ${p.domstol}${p.avgjorelsestype ? ` (${p.avgjorelsestype.toLowerCase()})` : ""}${p.dato ? ` – ${p.dato}` : ""} (del ${p.del}${p.avsnitt ? `, avsnitt ${p.avsnitt}` : ""})`,
    p.stikkord ? `Stikkord: ${p.stikkord}` : "",
    p.del.startsWith("1/") && p.sammendrag ? `Sammendrag (Lovdata): ${p.sammendrag}` : "",
    p.henvisninger ? `Henvisninger: ${p.henvisninger}` : "",
    `Fil: dommer/${p.fil} | Lovdata: ${p.lovdata_url}`,
  ].filter(Boolean);
  return `${head.join("\n")}\n\n${p.tekst}`;
}

export function lovdataSearchUrl(sokeord: string): string {
  return `https://lovdata.no/frisok?q=${encodeURIComponent(sokeord.trim())}`;
}
