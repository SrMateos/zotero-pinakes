/**
 * Reference-list cache: an in-memory map backed by one JSON file per item
 * in <Zotero data directory>/pinakes/.
 */
import { log } from "../utils/log";
import { describe } from "./sources";
import type { PaperId, ReferenceList } from "./types";

const CACHE_VERSION = 1;

interface CacheFile {
  version: number;
  list: ReferenceList;
}

const memory = new Map<string, ReferenceList>();

function cacheKey(item: Zotero.Item) {
  return `${item.libraryID}_${item.key}`;
}

export function cacheDir() {
  return PathUtils.join(Zotero.DataDirectory.dir, "pinakes");
}

function cachePath(item: Zotero.Item) {
  return PathUtils.join(cacheDir(), `${cacheKey(item)}.json`);
}

function samePaper(a: PaperId | undefined, b: PaperId | undefined) {
  if (!a || !b) return a === b;
  return a.kind === b.kind && a.value === b.value;
}

/**
 * Return the cached list for an item, or undefined. Entries fetched for a
 * different identifier (e.g. the DOI was edited) are ignored.
 */
export async function getCached(
  item: Zotero.Item,
  paperId: PaperId | undefined,
): Promise<ReferenceList | undefined> {
  const key = cacheKey(item);
  let list = memory.get(key);
  if (!list) {
    const path = cachePath(item);
    try {
      if (await IOUtils.exists(path)) {
        const data = (await IOUtils.readJSON(path)) as CacheFile;
        if (data?.version === CACHE_VERSION && data.list) {
          list = data.list;
          memory.set(key, list);
        }
      }
    } catch (e) {
      log(`Could not read cache file ${path}`, e);
    }
  }
  if (list && !samePaper(list.paperId, paperId)) {
    log(
      `Ignoring cache for ${key}: was ${describe(list.paperId)}, now ${describe(paperId)}`,
    );
    return undefined;
  }
  return list;
}

export async function setCached(item: Zotero.Item, list: ReferenceList) {
  memory.set(cacheKey(item), list);
  const path = cachePath(item);
  try {
    await IOUtils.makeDirectory(cacheDir(), { ignoreExisting: true });
    const data: CacheFile = { version: CACHE_VERSION, list };
    await IOUtils.writeJSON(path, data, { tmpPath: `${path}.tmp` });
  } catch (e) {
    log(`Could not write cache file ${path}`, e);
  }
}

export function clearMemoryCache() {
  memory.clear();
}
