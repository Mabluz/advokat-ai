import * as cheerio from "cheerio";
import { createHash } from "node:crypto";
import path from "node:path";
import { extractText } from "unpdf";
import { uuidv5 } from "../chunk.js";
import { DOM_CHUNK_CHARS } from "../config.js";
import { clean, nodeText } from "../lovdata/parse.js";

export const SUPPORTED = [".pdf", ".html", ".htm", ".txt", ".md"];

export const DOM_INDEXES = { saksnummer: "keyword", rt_ref: "keyword", domstol: "keyword", fil: "keyword", rekkefolge: "integer" } as const;

export interface DomPayload {
  saksnummer: string;
  /** Rt-2010-972 – the Norsk Retstidende reference Høyesterett decisions are usually cited by */
  rt_ref?: string;
  domstol: string;
  /** Dom, Kjennelse, Beslutning … */
  avgjorelsestype?: string;
  dato?: string;
  stikkord?: string;
  sammendrag?: string;
  henvisninger?: string;
  saksgang?: string;
  /** Canonical Lovdata URL when the saved file contains it (browser print footer), otherwise a search link */
  lovdata_url: string;
  fil: string;
  fil_hash: string;
  avsnitt?: string;
  del: string;
  tekst: string;
  rekkefolge: number;
}

export interface DomChunk {
  id: string;
  embedText: string;
  payload: DomPayload;
}

const LOVDATA_URL = /https:\/\/lovdata\.no\/dokument\/[A-Z]+\/avgjorelse\/[a-z0-9-]+/;

/** Browser print header/footer lines ("22/10/2026, 00:01 … - Lovdata", "https://lovdata.no/… 1/4") */
function stripPrintArtifacts(text: string): string {
  return text
    .split("\n")
    .filter((l) => !/^\d{1,2}[./]\d{1,2}[./]\d{2,4},? \d{1,2}:\d{2}\b.*Lovdata\s*$/.test(l))
    .filter((l) => !/^https?:\/\/\S+\s+\d+\/\d+\s*$/.test(l))
    .join("\n")
    .replace(/[\u0600-\u06FF\uE000-\uF8FF]/g, ""); // icon-font glyphs
}

export async function extractFileText(file: string, data: Buffer): Promise<string> {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".pdf") {
    const { text } = await extractText(new Uint8Array(data), { mergePages: true });
    const url = text.match(LOVDATA_URL)?.[0];
    // keep the canonical URL (it lives in the print footer we strip) as a marker line
    return clean(`${stripPrintArtifacts(text)}${url ? `\nLovdata-URL ${url}` : ""}`);
  }
  if (ext === ".html" || ext === ".htm") {
    const $ = cheerio.load(data.toString("utf8"));
    $("script, style, noscript, svg, nav, iframe, form, button").remove();
    const root = $("main").get(0) ?? $("body").get(0);
    return root ? clean(nodeText(root, () => false)) : "";
  }
  return clean(data.toString("utf8"));
}

// HR-2019-1725-A, LB-2020-123456, TOSLO-2021-12345, TRR-2019-1234, Rt-2008-1234
const CASE_NO = /\b(HR|Rt|L[ABEFGH]|TRR|T[A-ZÆØÅ]{2,9}|JS[A-ZÆØÅ]{0,8}|EMDN?)-(\d{4})-(\d{1,7})(?:-([A-Z]{1,2}))?\b/;

const COURTS: [RegExp, string][] = [
  [/^HR$|^Rt$/, "Høyesterett"],
  [/^LA$/, "Agder lagmannsrett"],
  [/^LB$/, "Borgarting lagmannsrett"],
  [/^LE$/, "Eidsivating lagmannsrett"],
  [/^LF$/, "Frostating lagmannsrett"],
  [/^LG$/, "Gulating lagmannsrett"],
  [/^LH$/, "Hålogaland lagmannsrett"],
  [/^TRR$/, "Trygderetten"],
  [/^JS/, "Jordskifterett"],
  [/^EMD/, "Den europeiske menneskerettsdomstol"],
  [/^T/, "Tingrett"],
];

const LABELS = [
  "Instans", "Dato", "Publisert", "Stikkord", "Sammendrag", "Henvisninger i teksten", "Henvisninger",
  "Saksgang", "Parter", "Forfatter", "Sist oppdatert", "Om rettskraft", "Rettskraft", "Lovdata-URL",
];
const LABEL_LINE = new RegExp(`^(${LABELS.join("|")})\\b\\s*:?`, "i");

/**
 * Value of a Lovdata header field. Values may continue over several lines (PDF wrapping) and end at the next
 * label or at the first numbered paragraph. Handles "Label value", "Label: value" and label/value on separate lines.
 */
function field(text: string, label: string): string | undefined {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^${label}\\b\\s*:?`, "i").test(l) && !(label === "Henvisninger" && /^Henvisninger i teksten/i.test(l)));
  if (start < 0) return undefined;
  const value = [lines[start].replace(new RegExp(`^${label}\\s*:?\\s*`, "i"), "")];
  // reference lists ("Tvisteloven (2005) §20-2 | …") are the last header field; the body follows directly,
  // so only lines that still look like references continue them
  const continues = /^Henvisninger/i.test(label) ? (l: string) => /§|\|\s|^\|/.test(l) || /\(\d{4}\)/.test(l) : () => true;
  for (const l of lines.slice(start + 1)) {
    if (LABEL_LINE.test(l) || /^\(\d{1,3}\)\s/.test(l) || !continues(l)) break;
    value.push(l);
  }
  return value.join(" ").replace(/\s+/g, " ").trim() || undefined;
}

function isoDate(s?: string): string | undefined {
  if (!s) return undefined;
  const iso = s.match(/\d{4}-\d{2}-\d{2}/);
  if (iso) return iso[0];
  const no = s.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  return no ? `${no[3]}-${no[2].padStart(2, "0")}-${no[1].padStart(2, "0")}` : undefined;
}

export function decisionMeta(text: string, file: string) {
  const head = text.slice(0, 6000);
  const publisert = field(head, "Publisert");
  const fromField = publisert?.match(CASE_NO)?.[0];
  const saksnummer = fromField ?? head.match(CASE_NO)?.[0] ?? path.basename(file).match(CASE_NO)?.[0] ?? path.parse(file).name;
  const rt = (publisert ?? head).match(/\bRt-\d{4}-\d+/)?.[0];
  const prefix = saksnummer.split("-")[0];
  // "Norges Høyesteretts ankeutvalg – Kjennelse."
  const [instans, type] = (field(head, "Instans") ?? "").split(/\s+[–-]\s+/);
  const domstol = instans || COURTS.find(([re]) => re.test(prefix))?.[1] || "Ukjent domstol";
  const url = text.match(LOVDATA_URL)?.[0];
  return {
    saksnummer,
    rt_ref: rt && rt !== saksnummer ? rt : undefined,
    domstol,
    avgjorelsestype: type?.replace(/\.$/, "") || undefined,
    dato: isoDate(field(head, "Dato")) ?? isoDate(head),
    stikkord: field(head, "Stikkord"),
    sammendrag: field(head, "Sammendrag")?.slice(0, 1500),
    henvisninger: [field(head, "Henvisninger"), field(head, "Henvisninger i teksten")].filter(Boolean).join(" | ") || undefined,
    saksgang: field(head, "Saksgang"),
    lovdata_url: url ?? `https://lovdata.no/frisok?q=${encodeURIComponent(saksnummer)}`,
  };
}

/** Signs that metadata extraction went wrong for a file – printed by `npm run dommer` so the user can tell us. */
export function metaWarnings(meta: ReturnType<typeof decisionMeta>, text: string): string[] {
  const w: string[] = [];
  if (!CASE_NO.test(meta.saksnummer)) w.push(`fant ikke saksnummer (bruker «${meta.saksnummer}»)`);
  if (meta.domstol === "Ukjent domstol") w.push("fant ikke domstol");
  if (!meta.dato) w.push("fant ikke dato");
  for (const [k, v] of Object.entries({ stikkord: meta.stikkord, henvisninger: meta.henvisninger, saksgang: meta.saksgang })) {
    if (v && v.length > 1200) w.push(`feltet «${k}» er mistenkelig langt (${v.length} tegn) – kan ha tatt med domstekst`);
  }
  if (text.length < 1500) w.push(`svært lite tekst (${text.length} tegn) – er filen komplett?`);
  return w;
}

function split(text: string): string[] {
  const parts: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    if (current && current.length + line.length + 1 > DOM_CHUNK_CHARS) {
      parts.push(current);
      current = "";
    }
    current = current ? `${current}\n${line}` : line;
  }
  if (current) parts.push(current);
  return parts;
}

/** Høyesterett and many other courts number their paragraphs "(12) ..." */
function avsnittRange(chunk: string): string | undefined {
  const nums = [...chunk.matchAll(/^\((\d{1,3})\)\s/gm)].map((m) => m[1]);
  if (!nums.length) return undefined;
  return nums.length === 1 ? `(${nums[0]})` : `(${nums[0]})–(${nums.at(-1)})`;
}

export function chunkDecision(text: string, file: string, fileHash: string): DomChunk[] {
  const meta = decisionMeta(text, file);
  const parts = split(text.replace(/\nLovdata-URL \S+$/, ""));
  const head = [meta.saksnummer, meta.rt_ref, meta.domstol, meta.avgjorelsestype, meta.dato].filter(Boolean).join(" – ");
  return parts.map((tekst, i) => {
    const payload: DomPayload = {
      ...meta,
      fil: file,
      fil_hash: fileHash,
      avsnitt: avsnittRange(tekst),
      del: `${i + 1}/${parts.length}`,
      tekst,
      rekkefolge: i,
    };
    const context = [head, meta.stikkord ? `Stikkord: ${meta.stikkord}` : "", meta.henvisninger ? `Henvisninger: ${meta.henvisninger}` : ""]
      .filter(Boolean)
      .join("\n");
    return { id: uuidv5(`dom|${file}|${i}`), embedText: `${context}\n\n${tekst}`, payload };
  });
}

/** Bump when extraction/metadata/chunking changes, so already indexed decisions are re-read. */
const PARSER_VERSION = "3";

export const fileHash = (data: Buffer) => createHash("sha1").update(`dom-parser-v${PARSER_VERSION}\n`).update(data).digest("hex");
