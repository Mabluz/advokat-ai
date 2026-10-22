/**
 * Incremental sync of Lovdata "gjeldende lover" + "gjeldende sentrale forskrifter" into Qdrant.
 *
 *   npm run sync         download if Lovdata has published new data, then embed only changed sections
 *   npm run sync:full    drop the collection and rebuild everything
 *   npm run sync:rolig   same as sync, but one batch at a time with pauses (less heat/fan noise)
 *   npm run sync:reindex re-parse the downloaded data even if Lovdata is unchanged (after parser/chunk changes)
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chunkDoc, type Chunk } from "./chunk.js";
import { CHANGES_DIR, DATASETS, DOCS_FILE, RAW_DIR } from "./config.js";
import { embed } from "./embed.js";
import { parseLawDoc, type LawDoc } from "./lovdata/parse.js";
import { downloadUpdated, readState, writeState } from "./lovdata/download.js";
import {
  countPoints,
  deletePoints,
  dropCollection,
  ensureCollection,
  existingHashes,
  overwritePayload,
  qdrant,
  upsert,
} from "./qdrant.js";
import { COLLECTION } from "./config.js";
import { sparseDoc } from "./sparse.js";

const BATCH = 32;
const QUIET = process.argv.includes("--rolig");
const CONCURRENCY = QUIET ? 1 : 2;
/** Pause after each batch in quiet mode, roughly halving GPU duty cycle. */
const PAUSE_MS = Number(process.env.EMBED_PAUSE_MS ?? (QUIET ? 1500 : 0));

export interface CatalogEntry extends Omit<LawDoc, "sections"> {
  antallChunks: number;
  fil: string;
}

async function parseAll(): Promise<{ docs: CatalogEntry[]; chunks: Chunk[] }> {
  const docs: CatalogEntry[] = [];
  const chunks = new Map<string, Chunk>();
  for (const ds of DATASETS) {
    const base = path.join(RAW_DIR, ds);
    for (const subdir of await readdir(base)) {
      const files = (await readdir(path.join(base, subdir))).filter((f) => f.endsWith(".xml"));
      for (const file of files) {
        const rel = path.join(ds, subdir, file);
        const doc = parseLawDoc(await readFile(path.join(base, subdir, file), "utf8"), subdir, file);
        if (!doc.dokId) {
          console.warn(`  hopper over ${rel}: mangler DokumentID`);
          continue;
        }
        const docChunks = chunkDoc(doc);
        for (const c of docChunks) chunks.set(c.id, c);
        const { sections: _sections, ...meta } = doc;
        docs.push({ ...meta, antallChunks: docChunks.length, fil: rel });
      }
    }
  }
  return { docs, chunks: [...chunks.values()] };
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}

function summarise(chunks: Chunk[]) {
  const byDoc = new Map<string, { korttittel: string; paragrafer: string[] }>();
  for (const c of chunks) {
    const e = byDoc.get(c.payload.dok_id) ?? { korttittel: c.payload.korttittel, paragrafer: [] };
    e.paragrafer.push(c.payload.paragraf + (c.payload.del ? ` (del ${c.payload.del})` : ""));
    byDoc.set(c.payload.dok_id, e);
  }
  return Object.fromEntries(byDoc);
}

async function main() {
  const full = process.argv.includes("--full");
  const reindex = process.argv.includes("--reindex");
  const started = Date.now();
  const state = await readState();

  console.log("Sjekker Lovdata for nye data …");
  const updated = await downloadUpdated(state);

  const { exists } = await qdrant.collectionExists(COLLECTION);
  const indexed = exists ? await countPoints() : 0;
  if (!full && !reindex && updated.length === 0 && indexed > 0) {
    state.lastSync = new Date().toISOString();
    await writeState(state);
    console.log(`Ingen endringer hos Lovdata. ${indexed} chunks i Qdrant.`);
    return;
  }

  if (full) {
    console.log("Full gjenoppbygging: sletter collection …");
    await dropCollection();
  }
  await ensureCollection();

  console.log("Parser dokumenter …");
  const { docs, chunks } = await parseAll();
  console.log(`  ${docs.length} dokumenter, ${chunks.length} chunks`);

  const existing = await existingHashes();
  const wanted = new Set(chunks.map((c) => c.id));
  const added: Chunk[] = [];
  const changed: Chunk[] = [];
  const payloadOnly: Chunk[] = [];
  for (const c of chunks) {
    const e = existing.get(c.id);
    if (!e) added.push(c);
    else if (e.embed !== c.payload.embed_hash) changed.push(c);
    else if (e.payload !== c.payload.payload_hash) payloadOnly.push(c);
  }
  const removed = [...existing.entries()].filter(([id]) => !wanted.has(id));
  console.log(
    `  nye: ${added.length}, endret tekst: ${changed.length}, endret metadata: ${payloadOnly.length}, fjernet: ${removed.length}`,
  );

  const toEmbed = [...added, ...changed];
  const batches: Chunk[][] = [];
  for (let i = 0; i < toEmbed.length; i += BATCH) batches.push(toEmbed.slice(i, i + BATCH));
  let done = 0;
  const embedStart = Date.now();
  await pool(batches, CONCURRENCY, async (batch) => {
    const vectors = await embed(batch.map((c) => c.embedText));
    await upsert(
      batch.map((c, i) => ({ id: c.id, dense: vectors[i], sparse: sparseDoc(c.embedText), payload: c.payload })),
    );
    done += batch.length;
    if (PAUSE_MS) await new Promise((r) => setTimeout(r, PAUSE_MS));
    if (done % (BATCH * 20) < BATCH || done === toEmbed.length) {
      const rate = done / ((Date.now() - embedStart) / 1000);
      const eta = Math.round((toEmbed.length - done) / rate / 60);
      console.log(`  embeddet ${done}/${toEmbed.length} (${rate.toFixed(1)}/s, ca. ${eta} min igjen)`);
    }
  });

  await pool(payloadOnly, 8, (c) => overwritePayload(c.id, c.payload));
  await deletePoints(removed.map(([id]) => id));

  await mkdir(CHANGES_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  if (!full && existing.size > 0) {
    const removedDocs: Record<string, number> = {};
    for (const [, e] of removed) removedDocs[e.dok] = (removedDocs[e.dok] ?? 0) + 1;
    await writeFile(
      path.join(CHANGES_DIR, `${stamp}.json`),
      JSON.stringify(
        {
          tidspunkt: new Date().toISOString(),
          lovdata: state.datasets,
          nye: summarise(added),
          endret: summarise(changed),
          fjernet_chunks_per_dokument: removedDocs,
          fjernede_dokumenter: Object.keys(removedDocs).filter((d) => !docs.some((x) => x.dokId === d)),
        },
        null,
        2,
      ),
    );
  }

  docs.sort((a, b) => a.korttittel.localeCompare(b.korttittel, "nb"));
  await writeFile(DOCS_FILE, JSON.stringify(docs));
  state.lastSync = new Date().toISOString();
  await writeState(state);
  console.log(`Ferdig på ${Math.round((Date.now() - started) / 1000)} s. ${await countPoints()} chunks i Qdrant.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
