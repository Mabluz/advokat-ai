import { QdrantClient, type Schemas } from "@qdrant/js-client-rest";
import type { ChunkPayload } from "./chunk.js";
import { COLLECTION, EMBED_DIM, QDRANT_URL } from "./config.js";
import type { SparseVector } from "./sparse.js";

export const qdrant = new QdrantClient({ url: QDRANT_URL, checkCompatibility: false });

export type Filter = Schemas["Filter"];
export type Condition = Schemas["Condition"];

const LAW_INDEXES: Record<string, "keyword" | "bool" | "integer"> = {
  dok_id: "keyword",
  ref_id: "keyword",
  type: "keyword",
  korttittel: "keyword",
  forkortelse: "keyword",
  paragraf_norm: "keyword",
  endringsdokument: "bool",
  rekkefolge: "integer",
};

export async function ensureCollection(collection = COLLECTION, indexes = LAW_INDEXES): Promise<void> {
  const { exists } = await qdrant.collectionExists(collection);
  if (exists) return;
  await qdrant.createCollection(collection, {
    vectors: { dense: { size: EMBED_DIM, distance: "Cosine", on_disk: true } },
    sparse_vectors: { sparse: { modifier: "idf" } },
  });
  for (const [field, schema] of Object.entries(indexes)) {
    await qdrant.createPayloadIndex(collection, { field_name: field, field_schema: schema, wait: true });
  }
}

export async function dropCollection(collection = COLLECTION): Promise<void> {
  const { exists } = await qdrant.collectionExists(collection);
  if (exists) await qdrant.deleteCollection(collection);
}

export interface PointUpsert<P = ChunkPayload> {
  id: string;
  dense: number[];
  sparse: SparseVector;
  payload: P;
}

export async function upsert<P>(points: PointUpsert<P>[], collection = COLLECTION): Promise<void> {
  await qdrant.upsert(collection, {
    wait: true,
    points: points.map((p) => ({
      id: p.id,
      vector: { dense: p.dense, sparse: p.sparse },
      payload: p.payload as unknown as Record<string, unknown>,
    })),
  });
}

export async function overwritePayload(id: string, payload: ChunkPayload): Promise<void> {
  await qdrant.overwritePayload(COLLECTION, {
    points: [id],
    payload: payload as unknown as Record<string, unknown>,
  });
}

export async function deletePoints(ids: string[], collection = COLLECTION): Promise<void> {
  for (let i = 0; i < ids.length; i += 1000) {
    await qdrant.delete(collection, { wait: true, points: ids.slice(i, i + 1000) });
  }
}

/** Point ID → selected payload fields, for all points (used by incremental syncs). */
export async function scrollFields(fields: string[], collection = COLLECTION): Promise<Map<string, Record<string, string>>> {
  const out = new Map<string, Record<string, string>>();
  const { exists } = await qdrant.collectionExists(collection);
  if (!exists) return out;
  let offset: string | number | undefined | null = undefined;
  do {
    const res = await qdrant.scroll(collection, {
      limit: 2000,
      offset: offset ?? undefined,
      with_payload: fields,
      with_vector: false,
    });
    for (const p of res.points) out.set(String(p.id), p.payload as Record<string, string>);
    offset = res.next_page_offset as string | number | null | undefined;
  } while (offset);
  return out;
}

/** All point IDs with their hashes — the authoritative "what is indexed" view for incremental sync. */
export async function existingHashes(): Promise<Map<string, { embed: string; payload: string; dok: string }>> {
  const out = new Map<string, { embed: string; payload: string; dok: string }>();
  for (const [id, pl] of await scrollFields(["embed_hash", "payload_hash", "dok_id"])) {
    out.set(id, { embed: pl.embed_hash, payload: pl.payload_hash, dok: pl.dok_id });
  }
  return out;
}

export async function hybridSearch<P = ChunkPayload>(
  dense: number[],
  sparse: SparseVector,
  limit: number,
  filter?: Filter,
  collection = COLLECTION,
) {
  const res = await qdrant.query(collection, {
    prefetch: [
      { query: dense, using: "dense", limit: Math.max(50, limit * 4), filter },
      { query: sparse, using: "sparse", limit: Math.max(50, limit * 4), filter },
    ],
    query: { fusion: "rrf" },
    limit,
    with_payload: true,
  });
  return res.points.map((p) => ({ score: p.score, payload: p.payload as unknown as P }));
}

export async function scrollAll<P extends { rekkefolge: number } = ChunkPayload>(
  filter: Filter,
  limit = 10000,
  collection = COLLECTION,
): Promise<P[]> {
  const out: P[] = [];
  let offset: string | number | undefined | null = undefined;
  do {
    const res = await qdrant.scroll(collection, {
      filter,
      limit: Math.min(1000, limit - out.length),
      offset: offset ?? undefined,
      with_payload: true,
      with_vector: false,
    });
    out.push(...res.points.map((p) => p.payload as unknown as P));
    offset = res.next_page_offset as string | number | null | undefined;
  } while (offset && out.length < limit);
  return out.sort((a, b) => a.rekkefolge - b.rekkefolge);
}

export async function countPoints(collection = COLLECTION): Promise<number> {
  const { exists } = await qdrant.collectionExists(collection);
  return exists ? (await qdrant.count(collection, { exact: true })).count : 0;
}
