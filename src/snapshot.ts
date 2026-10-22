import { createReadStream, createWriteStream, openAsBlob } from "node:fs";
import { rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import { QDRANT_URL } from "./config.js";
import { countPoints, qdrant } from "./qdrant.js";

export const mb = (bytes: number) => `${(bytes / 1e6).toFixed(0)} MB`;

/** Creates a Qdrant snapshot of `collection` and stores it gzipped at `file`. Returns the point count. */
export async function snapshotTo(collection: string, file: string): Promise<number> {
  const points = await countPoints(collection);
  console.log(`Lager snapshot av «${collection}» (${points} chunks) …`);
  const snap = await qdrant.createSnapshot(collection, { wait: true });
  if (!snap) throw new Error("Qdrant returnerte ikke noe snapshot");
  try {
    const res = await fetch(`${QDRANT_URL}/collections/${collection}/snapshots/${encodeURIComponent(snap.name)}`);
    if (!res.ok || !res.body) throw new Error(`Nedlasting av snapshot feilet: ${res.status}`);
    // snapshots contain large preallocated, mostly empty regions – gzip shrinks them a lot
    await pipeline(Readable.fromWeb(res.body as never), createGzip({ level: 6 }), createWriteStream(file));
  } finally {
    await qdrant.deleteSnapshot(collection, snap.name);
  }
  if ((await countPoints(collection)) !== points) {
    throw new Error(`«${collection}» endret seg under eksporten (kjører en synk?). Vent til den er ferdig og prøv igjen.`);
  }
  return points;
}

/** Replaces `collection` with the gzipped snapshot in `gzFile`. */
export async function uploadSnapshot(collection: string, gzFile: string) {
  const unpacked = gzFile.replace(/\.gz$/, "");
  console.log(`Pakker ut ${path.basename(gzFile)} (${mb((await stat(gzFile)).size)}) …`);
  await pipeline(createReadStream(gzFile), createGunzip(), createWriteStream(unpacked));
  console.log(`Laster opp til «${collection}» – eksisterende innhold erstattes …`);
  const form = new FormData();
  form.append("snapshot", await openAsBlob(unpacked), path.basename(unpacked));
  const res = await fetch(`${QDRANT_URL}/collections/${collection}/snapshots/upload?priority=snapshot&wait=true`, {
    method: "POST",
    body: form,
  }).finally(() => rm(unpacked, { force: true }));
  if (!res.ok) throw new Error(`Import av «${collection}» feilet: ${res.status} ${await res.text()}`);
}
