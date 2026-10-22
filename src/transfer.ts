/**
 * Share a finished index without re-embedding:
 *
 *   npm run export   Qdrant snapshots (lover + rettspraksis) + catalog + sync state + dommer/ → export/
 *   npm run import   import/ → Qdrant (replaces the collections) + data/ + dommer/
 */
import { cp, copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  COLLECTION,
  DATA_DIR,
  DOCS_FILE,
  DOMMER_COLLECTION,
  DOMMER_DIR,
  EMBED_DIM,
  EMBED_MODEL,
  QDRANT_URL,
  ROOT,
  STATE_FILE,
} from "./config.js";
import { countPoints } from "./qdrant.js";
import { mb, snapshotTo, uploadSnapshot } from "./snapshot.js";
import type { CatalogEntry } from "./sync.js";

const EXPORT_DIR = path.join(ROOT, "export");
const IMPORT_DIR = path.join(ROOT, "import");

interface Manifest {
  collections: { name: string; snapshot: string; points: number }[];
  embedModel: string;
  embedDim: number;
  qdrantVersion: string;
  lovdata: unknown;
  exportedAt: string;
}

/** Empties export/ but keeps .gitkeep so the folder stays in git. */
async function clearExport() {
  await mkdir(EXPORT_DIR, { recursive: true });
  for (const f of await readdir(EXPORT_DIR)) {
    if (f !== ".gitkeep") await rm(path.join(EXPORT_DIR, f), { recursive: true, force: true });
  }
}

async function qdrantVersion(): Promise<string> {
  return ((await (await fetch(QDRANT_URL)).json()) as { version: string }).version;
}

async function exportIndex() {
  const catalog = JSON.parse(await readFile(DOCS_FILE, "utf8").catch(() => "null")) as CatalogEntry[] | null;
  if (!catalog) throw new Error("Fant ikke data/docs.json – kjør `npm run sync` ferdig før eksport.");
  const lawPoints = await countPoints();
  const expected = catalog.reduce((sum, d) => sum + d.antallChunks, 0);
  if (lawPoints < expected) {
    throw new Error(`Indeksen er ufullstendig (${lawPoints}/${expected} chunks) – kjør \`npm run sync\` ferdig før eksport.`);
  }

  await clearExport();
  const collections: Manifest["collections"] = [];
  for (const name of [COLLECTION, DOMMER_COLLECTION]) {
    if (name !== COLLECTION && !(await countPoints(name))) continue;
    const snapshot = `${name}.snapshot.gz`;
    try {
      collections.push({ name, snapshot, points: await snapshotTo(name, path.join(EXPORT_DIR, snapshot)) });
    } catch (err) {
      await clearExport();
      throw err;
    }
  }

  await copyFile(DOCS_FILE, path.join(EXPORT_DIR, "docs.json"));
  await copyFile(STATE_FILE, path.join(EXPORT_DIR, "state.json"));
  // the original decision files, so `npm run dommer` on the receiving side keeps (not deletes) them
  await cp(DOMMER_DIR, path.join(EXPORT_DIR, "dommer"), { recursive: true, filter: (src) => !src.endsWith(".gitkeep") });

  const manifest: Manifest = {
    collections,
    embedModel: EMBED_MODEL,
    embedDim: EMBED_DIM,
    qdrantVersion: await qdrantVersion(),
    lovdata: JSON.parse(await readFile(STATE_FILE, "utf8")).datasets,
    exportedAt: new Date().toISOString(),
  };
  await writeFile(path.join(EXPORT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));

  let size = 0;
  for (const c of collections) size += (await stat(path.join(EXPORT_DIR, c.snapshot))).size;
  console.log(
    `Ferdig: export/ (${mb(size)}; ${collections.map((c) => `${c.name}: ${c.points}`).join(", ")}). ` +
      "Del hele mappa; mottaker legger innholdet i import/ og kjører `npm run import`.",
  );
}

async function importIndex() {
  const manifest = JSON.parse(
    await readFile(path.join(IMPORT_DIR, "manifest.json"), "utf8").catch(() => {
      throw new Error("Fant ikke import/manifest.json – legg alle filene fra en eksport i import/.");
    }),
  ) as Manifest;
  if (manifest.embedModel !== EMBED_MODEL || manifest.embedDim !== EMBED_DIM) {
    throw new Error(
      `Eksporten er laget med ${manifest.embedModel} (${manifest.embedDim}d), men prosjektet bruker ${EMBED_MODEL} (${EMBED_DIM}d).`,
    );
  }
  const local = await qdrantVersion();
  if (local !== manifest.qdrantVersion) {
    console.warn(`Advarsel: eksporten er fra Qdrant ${manifest.qdrantVersion}, lokal Qdrant er ${local}.`);
  }

  for (const c of manifest.collections) {
    await uploadSnapshot(c.name, path.join(IMPORT_DIR, c.snapshot));
    const points = await countPoints(c.name);
    if (points !== c.points) throw new Error(`«${c.name}»: forventet ${c.points} chunks, fant ${points}`);
    console.log(`  «${c.name}»: ${points} chunks importert`);
  }

  await mkdir(DATA_DIR, { recursive: true });
  await copyFile(path.join(IMPORT_DIR, "docs.json"), DOCS_FILE);
  await copyFile(path.join(IMPORT_DIR, "state.json"), STATE_FILE);
  const importedDommer = path.join(IMPORT_DIR, "dommer");
  if (await stat(importedDommer).catch(() => undefined)) {
    await cp(importedDommer, DOMMER_DIR, { recursive: true });
  }

  console.log(`Ferdig (lovdata per ${JSON.stringify(manifest.lovdata)}).`);
  console.log("Kjør `npm run sync` for å hente eventuelle endringer hos Lovdata siden eksporten.");
}

const command = process.argv[2];
const run = command === "export" ? exportIndex : command === "import" ? importIndex : undefined;
if (!run) {
  console.error("Bruk: tsx src/transfer.ts export|import");
  process.exit(1);
}
run().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
