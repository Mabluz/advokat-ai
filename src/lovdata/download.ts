import { execFile } from "node:child_process";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { DATA_DIR, DATASETS, LOVDATA_API, RAW_DIR, STATE_FILE, type Dataset } from "../config.js";

const exec = promisify(execFile);

interface RemoteFile {
  filename: string;
  description: string;
  sizeBytes: string;
  lastModified: string;
}

export interface SyncState {
  datasets: Partial<Record<Dataset, { lastModified: string; downloadedAt: string }>>;
  lastSync?: string;
}

export async function readState(): Promise<SyncState> {
  try {
    return JSON.parse(await readFile(STATE_FILE, "utf8"));
  } catch {
    return { datasets: {} };
  }
}

export async function writeState(state: SyncState): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

export async function listRemote(): Promise<Map<string, RemoteFile>> {
  const res = await fetch(`${LOVDATA_API}/list`);
  if (!res.ok) throw new Error(`Lovdata list feilet: ${res.status}`);
  const files = (await res.json()) as RemoteFile[];
  return new Map(files.map((f) => [f.filename.replace(/\.tar\.bz2$/, ""), f]));
}

/**
 * Downloads datasets whose lastModified differs from the stored state.
 * Returns the datasets that were (re)downloaded; the state is updated in memory only.
 */
export async function downloadUpdated(state: SyncState, force = false): Promise<Dataset[]> {
  const remote = await listRemote();
  const updated: Dataset[] = [];
  for (const ds of DATASETS) {
    const info = remote.get(ds);
    if (!info) throw new Error(`Datasett ${ds} finnes ikke lenger hos Lovdata`);
    if (!force && state.datasets[ds]?.lastModified === info.lastModified) {
      console.log(`  ${ds}: uendret (${info.lastModified})`);
      continue;
    }
    console.log(`  ${ds}: laster ned (${(+info.sizeBytes / 1e6).toFixed(1)} MB, ${info.lastModified})`);
    const res = await fetch(`${LOVDATA_API}/get/${ds}.tar.bz2`);
    if (!res.ok) throw new Error(`Nedlasting av ${ds} feilet: ${res.status}`);
    const archive = path.join(DATA_DIR, `${ds}.tar.bz2`);
    await writeFile(archive, Buffer.from(await res.arrayBuffer()));
    const target = path.join(RAW_DIR, ds);
    await rm(target, { recursive: true, force: true });
    await mkdir(target, { recursive: true });
    await exec("tar", ["-xjf", archive, "-C", target]);
    state.datasets[ds] = { lastModified: info.lastModified, downloadedAt: new Date().toISOString() };
    updated.push(ds);
  }
  return updated;
}
