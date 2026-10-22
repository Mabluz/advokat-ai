import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readState } from "./lovdata/download.js";
import { DOMMER_COLLECTION } from "./config.js";
import { countPoints } from "./qdrant.js";
import {
  findDocs,
  formatChunk,
  formatDecision,
  formatDocMeta,
  getDecision,
  getDocument,
  getParagraph,
  loadCatalog,
  lovdataSearchUrl,
  search,
  searchDecisions,
} from "./search.js";

const MAX_OUTPUT_CHARS = 80_000;

const server = new McpServer({ name: "norsk-lov", version: "1.0.0" });

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

async function dataAsOf(): Promise<string> {
  const s = await readState();
  const dates = Object.entries(s.datasets).map(([k, v]) => `${k}: ${v?.lastModified}`);
  return `Datagrunnlag: Lovdata (${dates.join(", ")})`;
}

const docTypes = z.enum(["lov", "forskrift", "delegering", "instruks", "stortingsvedtak"]);

server.registerTool(
  "sok_lov",
  {
    title: "Søk i gjeldende norsk lovverk",
    description:
      "Hybridsøk (semantisk + nøkkelord) i alle gjeldende norske lover og sentrale forskrifter fra Lovdata. " +
      "Formuler søket på norsk med juridiske fagord når mulig (f.eks. «skjevdeling ved skilsmisse», «oppsigelse av arbeidstaker i prøvetid»). " +
      "Kjør gjerne flere søk med ulike formuleringer, og avgrens med `lov` når du vet hvilken lov det gjelder.",
    inputSchema: {
      sporsmal: z.string().describe("Søketekst på norsk"),
      lov: z.string().optional().describe("Avgrens til én lov/forskrift: korttittel, forkortelse eller ID (f.eks. «ekteskapsloven», «tvl», «TEK17»)"),
      type: docTypes.optional().describe("Avgrens til dokumenttype"),
      inkluder_endringsdokumenter: z.boolean().optional().describe("Ta med endringslover/-forskrifter (kommende endringer). Standard false."),
      antall: z.number().int().min(1).max(25).optional().describe("Antall treff (standard 8)"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ sporsmal, lov, type, inkluder_endringsdokumenter, antall }) => {
    const { resolved, hits } = await search(sporsmal, {
      lov,
      type,
      inkluderEndringsdokumenter: inkluder_endringsdokumenter,
      antall,
    });
    if (!hits.length) return text("Ingen treff.");
    const scope = resolved ? `Avgrenset til: ${resolved.korttittel} (${resolved.dokId})\n` : "";
    return text(`${await dataAsOf()}\n${scope}\n${hits.map((h, i) => formatChunk(h.payload, i + 1)).join("\n\n---\n\n")}`);
  },
);

server.registerTool(
  "hent_paragraf",
  {
    title: "Hent en bestemt paragraf",
    description: "Henter ordlyden i en bestemt paragraf, f.eks. lov=«tvisteloven», paragraf=«4-1», eller lov=«TEK17», paragraf=«§ 12-7».",
    inputSchema: {
      lov: z.string().describe("Korttittel, forkortelse eller ID"),
      paragraf: z.string().describe("Paragrafnummer, f.eks. «58», «1 a», «§ 12-7»"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ lov, paragraf }) => {
    const { doc, parts } = await getParagraph(lov, paragraf);
    if (!doc) return text(`Fant ingen lov/forskrift som matcher «${lov}». Bruk list_lover.`);
    if (!parts.length) return text(`Fant ikke § ${paragraf} i ${doc.korttittel} (${doc.dokId}). Bruk hent_lov for å se innholdsfortegnelsen.`);
    return text(`${await dataAsOf()}\n\n${parts.map((p) => formatChunk(p)).join("\n\n---\n\n")}`);
  },
);

server.registerTool(
  "hent_lov",
  {
    title: "Hent en hel lov eller et kapittel",
    description:
      "Henter en lov/forskrift i rekkefølge. Uten `kapittel` returneres metadata og innholdsfortegnelse hvis teksten er lang; " +
      "med `kapittel` (f.eks. «12», «Kapittel 3», «Del II») returneres full tekst for kapittelet. Bruk dette for å se sammenhengen rundt en paragraf.",
    inputSchema: {
      lov: z.string().describe("Korttittel, forkortelse eller ID"),
      kapittel: z.string().optional().describe("Kapittel/del å hente"),
      full_tekst: z.boolean().optional().describe("Returner full tekst selv uten kapittel (avkortes ved svært lange dokumenter)"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ lov, kapittel, full_tekst }) => {
    const { doc, parts } = await getDocument(lov, kapittel);
    if (!doc) return text(`Fant ingen lov/forskrift som matcher «${lov}». Bruk list_lover.`);
    const meta = formatDocMeta(doc);
    if (!parts.length) return text(`${meta}\n\nIngen tekst funnet${kapittel ? ` for kapittel «${kapittel}»` : ""}.`);
    const full = parts.map((p) => formatChunk(p)).join("\n\n---\n\n");
    if ((kapittel || full_tekst) && full.length <= MAX_OUTPUT_CHARS) return text(`${meta}\n\n${full}`);
    const toc = parts
      .map((p) => `${p.kapittel.join(" > ")} | ${p.paragraf}${p.overskrift ? ` ${p.overskrift}` : ""}${p.del ? ` (del ${p.del})` : ""}`)
      .filter((l, i, a) => a.indexOf(l) === i)
      .join("\n");
    const note = kapittel || full_tekst ? "Teksten er for lang til å returneres samlet; her er innholdet. Hent enkeltparagrafer eller et smalere kapittel.\n" : "";
    return text(`${meta}\n\n${note}Innhold (${parts.length} deler):\n${toc}`.slice(0, MAX_OUTPUT_CHARS));
  },
);

server.registerTool(
  "list_lover",
  {
    title: "Finn lover og forskrifter",
    description: "Søker i titlene på alle gjeldende lover/forskrifter. Bruk når du er usikker på hva en lov heter eller vil se relevante forskrifter (f.eks. «husleie», «plan- og bygning», «barn»).",
    inputSchema: {
      sok: z.string().describe("Del av tittel, korttittel eller forkortelse"),
      type: docTypes.optional(),
      antall: z.number().int().min(1).max(100).optional(),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ sok, type, antall }) => {
    const docs = (await findDocs(sok, 500)).filter((d) => !type || d.type === type).slice(0, antall ?? 30);
    if (!docs.length) return text("Ingen treff.");
    return text(docs.map(formatDocMeta).join("\n\n"));
  },
);

server.registerTool(
  "status",
  {
    title: "Status for lovdatabasen",
    description: "Viser når lovdataene sist ble oppdatert og hvor mye som er indeksert.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => {
    const s = await readState();
    const cat = await loadCatalog();
    const counts: Record<string, number> = {};
    for (const d of cat) counts[d.type] = (counts[d.type] ?? 0) + 1;
    return text(
      [
        await dataAsOf(),
        `Siste synk: ${s.lastSync ?? "aldri"}`,
        `Dokumenter: ${cat.length} (${Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(", ")})`,
        `Chunks i Qdrant: ${await countPoints()}`,
        `Rettspraksis (brukerens egne filer i dommer/): ${await countPoints(DOMMER_COLLECTION)} deler`,
        "Omfatter IKKE: rettspraksis utover det brukeren har lagt inn, forarbeider, rundskriv, lokale forskrifter/reguleringsplaner.",
      ].join("\n"),
    );
  },
);

server.registerTool(
  "sok_dommer",
  {
    title: "Søk i lagrede rettsavgjørelser",
    description:
      "Søker i rettsavgjørelser brukeren selv har lagret i dommer/-mappa. Samlingen er IKKE komplett, " +
      "så at noe mangler betyr ikke at det ikke finnes praksis. Bruk lovdata_sok_lenke for å la brukeren finne flere.",
    inputSchema: {
      sporsmal: z.string().describe("Søketekst på norsk"),
      antall: z.number().int().min(1).max(20).optional().describe("Antall ulike avgjørelser (standard 6, inntil 2 utdrag per avgjørelse)"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ sporsmal, antall }) => {
    const hits = await searchDecisions(sporsmal, antall);
    if (!hits.length) {
      return text(`Ingen lagrede avgjørelser matcher. Brukeren kan søke her og lagre relevante dommer i dommer/: ${lovdataSearchUrl(sporsmal)}`);
    }
    return text(hits.map((h, i) => formatDecision(h.payload, i + 1)).join("\n\n---\n\n"));
  },
);

server.registerTool(
  "hent_dom",
  {
    title: "Hent en lagret rettsavgjørelse",
    description: "Henter hele teksten i en lagret avgjørelse i rekkefølge, ut fra saksnummer (f.eks. «HR-2019-1725-A»).",
    inputSchema: { saksnummer: z.string() },
    annotations: { readOnlyHint: true },
  },
  async ({ saksnummer }) => {
    const parts = await getDecision(saksnummer);
    if (!parts.length) {
      return text(`${saksnummer} er ikke lagret. Brukeren kan finne den her og legge den i dommer/: ${lovdataSearchUrl(saksnummer)}`);
    }
    const full = parts.map((p) => formatDecision(p)).join("\n\n");
    return text(full.length > MAX_OUTPUT_CHARS ? `${full.slice(0, MAX_OUTPUT_CHARS)}\n\n[avkortet – bruk sok_dommer for å finne bestemte avsnitt]` : full);
  },
);

server.registerTool(
  "lovdata_sok_lenke",
  {
    title: "Lag søkelenke til Lovdata",
    description:
      "Lager en lenke til Lovdatas fritekstsøk som BRUKEREN kan åpne (du skal ikke åpne den selv – lovdata.no tillater ikke automatisk tilgang). " +
      "Bruk korte, presise juridiske søkeord, gjerne med lovhenvisning, f.eks. «grannelova § 2 gjerde» eller «arbeidsmiljøloven § 15-7 saklig oppsigelse».",
    inputSchema: { sokeord: z.string() },
    annotations: { readOnlyHint: true },
  },
  async ({ sokeord }) => text(lovdataSearchUrl(sokeord)),
);

await server.connect(new StdioServerTransport());
