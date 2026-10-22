import { createHash } from "node:crypto";
import { MAX_CHUNK_CHARS } from "./config.js";
import type { LawDoc, LawSection } from "./lovdata/parse.js";

export interface ChunkPayload {
  dok_id: string;
  ref_id: string;
  type: LawDoc["type"];
  endringsdokument: boolean;
  tittel: string;
  korttittel: string;
  forkortelse?: string;
  kapittel: string[];
  paragraf: string;
  paragraf_norm?: string;
  overskrift?: string;
  del?: string;
  tekst: string;
  endringshistorikk?: string;
  url: string;
  i_kraft_fra?: string;
  siste_endring_i_kraft?: string;
  rekkefolge: number;
  embed_hash: string;
  payload_hash: string;
}

export interface Chunk {
  id: string;
  /** Text sent to the embedding model (context header + body) */
  embedText: string;
  payload: ChunkPayload;
}

/** Bump to force re-embedding of everything (e.g. changed header format). */
const EMBED_VERSION = "1";

const sha1 = (s: string) => createHash("sha1").update(s).digest();

/** RFC 4122 UUIDv5 in a fixed namespace, so the same section always maps to the same point. */
export function uuidv5(name: string): string {
  const h = sha1(`advokat:norsk_lov:${name}`);
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

function splitLong(text: string): string[] {
  if (text.length <= MAX_CHUNK_CHARS) return [text];
  const parts: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    if (current && current.length + line.length + 1 > MAX_CHUNK_CHARS) {
      parts.push(current);
      current = "";
    }
    // a single over-long line is cut hard
    for (let i = 0; i < line.length; i += MAX_CHUNK_CHARS) {
      const piece = line.slice(i, i + MAX_CHUNK_CHARS);
      current = current ? `${current}\n${piece}` : piece;
      if (current.length >= MAX_CHUNK_CHARS) {
        parts.push(current);
        current = "";
      }
    }
  }
  if (current) parts.push(current);
  return parts;
}

export function header(doc: LawDoc, s: LawSection): string {
  const name = doc.forkortelse && !doc.korttittel.includes(doc.forkortelse)
    ? `${doc.korttittel} (${doc.forkortelse})`
    : doc.korttittel;
  const where = [...s.kapittel, s.paragrafNorm ? [s.paragraf, s.overskrift].filter(Boolean).join(" ") : ""]
    .filter(Boolean)
    .join(" > ");
  return `${name} – ${doc.tittel}${where ? `\n${where}` : ""}`;
}

export function chunkDoc(doc: LawDoc): Chunk[] {
  const chunks: Chunk[] = [];
  let order = 0;
  for (const s of doc.sections) {
    const parts = splitLong(s.tekst);
    parts.forEach((tekst, i) => {
      const del = parts.length > 1 ? `${i + 1}/${parts.length}` : undefined;
      const embedText = `${header(doc, s)}${del ? ` (del ${del})` : ""}\n\n${tekst}`;
      const base = {
        dok_id: doc.dokId,
        ref_id: doc.refId,
        type: doc.type,
        endringsdokument: doc.endringsdokument,
        tittel: doc.tittel,
        korttittel: doc.korttittel,
        forkortelse: doc.forkortelse,
        kapittel: s.kapittel,
        paragraf: s.paragraf,
        paragraf_norm: s.paragrafNorm,
        overskrift: s.overskrift,
        del,
        tekst,
        endringshistorikk: s.endringshistorikk,
        url: s.url,
        i_kraft_fra: doc.iKraftFra,
        siste_endring_i_kraft: doc.sisteEndringIKraft,
        rekkefolge: order++,
      };
      const embed_hash = sha1(`${EMBED_VERSION}\n${embedText}`).toString("hex");
      const payload_hash = sha1(JSON.stringify(base)).toString("hex");
      chunks.push({
        id: uuidv5(`${doc.dokId}|${s.key}|${i}`),
        embedText,
        payload: { ...base, embed_hash, payload_hash },
      });
    });
  }
  return chunks;
}
