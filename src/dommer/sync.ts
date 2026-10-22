/**
 * Indexes court decisions the user has saved into dommer/ (PDF, HTML, TXT, MD).
 *
 *   npm run dommer      add new/changed files, remove decisions whose file was deleted
 *
 * Nothing is downloaded: the user finds decisions on lovdata.no and saves them here.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { DOMMER_COLLECTION, DOMMER_DIR } from "../config.js";
import { embed } from "../embed.js";
import { deletePoints, ensureCollection, scrollFields, upsert } from "../qdrant.js";
import { sparseDoc } from "../sparse.js";
import { chunkDecision, decisionMeta, DOM_INDEXES, extractFileText, fileHash, metaWarnings, SUPPORTED } from "./parse.js";

async function listFiles(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full, base)));
    else if (SUPPORTED.includes(path.extname(entry.name).toLowerCase())) out.push(path.relative(base, full));
  }
  return out.sort();
}

async function main() {
  await ensureCollection(DOMMER_COLLECTION, DOM_INDEXES);
  const files = await listFiles(DOMMER_DIR);

  // file → hash currently indexed
  const indexed = new Map<string, { hash: string; ids: string[] }>();
  for (const [id, pl] of await scrollFields(["fil", "fil_hash"], DOMMER_COLLECTION)) {
    const e = indexed.get(pl.fil) ?? { hash: pl.fil_hash, ids: [] };
    e.ids.push(id);
    indexed.set(pl.fil, e);
  }

  let added = 0;
  let warnings = 0;
  for (const file of files) {
    const data = await readFile(path.join(DOMMER_DIR, file));
    const hash = fileHash(data);
    const existing = indexed.get(file);
    indexed.delete(file);
    if (existing?.hash === hash) continue;
    if (existing) await deletePoints(existing.ids, DOMMER_COLLECTION);

    const text = await extractFileText(file, data);
    if (text.length < 200) {
      console.warn(`  ${file}: fant nesten ingen tekst (skannet PDF?) – hoppet over`);
      continue;
    }
    const chunks = chunkDecision(text, file, hash);
    for (let i = 0; i < chunks.length; i += 16) {
      const batch = chunks.slice(i, i + 16);
      const vectors = await embed(batch.map((c) => c.embedText));
      await upsert(
        batch.map((c, j) => ({ id: c.id, dense: vectors[j], sparse: sparseDoc(c.embedText), payload: c.payload })),
        DOMMER_COLLECTION,
      );
    }
    const m = chunks[0].payload;
    console.log(`  ${existing ? "oppdatert" : "ny"}: ${m.saksnummer} (${m.domstol}${m.dato ? `, ${m.dato}` : ""}) – ${chunks.length} deler  [${file}]`);
    const fileWarnings = metaWarnings(decisionMeta(text, file), text);
    for (const w of fileWarnings) console.log(`    ⚠ ${w}`);
    if (fileWarnings.length) warnings++;
    added++;
  }

  // files that are gone from dommer/
  for (const [file, e] of indexed) {
    await deletePoints(e.ids, DOMMER_COLLECTION);
    console.log(`  fjernet: ${file}`);
  }

  console.log(`Ferdig. ${files.length} filer i dommer/, ${added} lest inn, ${indexed.size} fjernet.`);
  if (warnings) {
    console.log(`${warnings} fil(er) har ⚠-advarsler. Selve teksten er likevel lest inn og søkbar; advarslene gjelder bare metadata.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
