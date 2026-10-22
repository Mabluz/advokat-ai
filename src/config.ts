import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_DIR = path.join(ROOT, "data");
export const RAW_DIR = path.join(DATA_DIR, "raw");
export const STATE_FILE = path.join(DATA_DIR, "state.json");
export const DOCS_FILE = path.join(DATA_DIR, "docs.json");
export const CHANGES_DIR = path.join(DATA_DIR, "changes");

export const LOVDATA_API = "https://api.lovdata.no/v1/publicData";
export const DATASETS = ["gjeldende-lover", "gjeldende-sentrale-forskrifter"] as const;
export type Dataset = (typeof DATASETS)[number];

export const QDRANT_URL = process.env.QDRANT_URL ?? "http://localhost:6343";
export const COLLECTION = process.env.QDRANT_COLLECTION ?? "norsk_lov";

export const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
export const EMBED_MODEL = process.env.EMBED_MODEL ?? "bge-m3";
export const EMBED_DIM = 1024;

/** Chunks longer than this (characters) are split on line boundaries. */
export const MAX_CHUNK_CHARS = 3500;

/** Court decisions the user has saved manually from lovdata.no (never fetched automatically). */
export const DOMMER_DIR = path.join(ROOT, "dommer");
export const DOMMER_COLLECTION = process.env.QDRANT_DOMMER_COLLECTION ?? "rettspraksis";
export const DOM_CHUNK_CHARS = 2500;
