import type { CardDbState, CardInfo } from '@drafttracker/core';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { Readable, Transform } from 'node:stream';
import { createGunzip } from 'node:zlib';
import {
  CACHE_VERSION,
  CardDatabase,
  databaseFromCache,
  decodeCardFields,
  decodeCompactCard,
  fingerprintKeys,
  printingKey,
  type CardFields,
  type CompactCard,
} from './database.js';

const CACHE_FILE_NAME = 'cards.json';
const BULK_DATA_URL = 'https://api.scryfall.com/bulk-data';

// Scryfall rejects requests missing User-Agent or Accept with a 400. Node's
// fetch sends neither by default, so set both explicitly.
const REQUEST_HEADERS = {
  'User-Agent': 'drafttracker/0.1',
  Accept: 'application/json',
} as const;

/** Throttle progress callbacks — the parse loop runs hundreds of thousands of times. */
const PROGRESS_INTERVAL_MS = 100;

export interface LoadCardDatabaseOptions {
  cacheDir: string;
  /** Re-download even when a cache file exists. */
  forceRefresh?: boolean;
  /** Injectable fetch, for tests. */
  fetchImpl?: typeof fetch;
  /** Progress, throttled to ~10 updates/second. */
  onProgress?: (state: CardDbState) => void;
  signal?: AbortSignal;
  /**
   * Restrict the printing index to these "SET:collectorNumber" keys.
   *
   * Only printings Scryfall has no `arena_id` for are indexed, so this is what
   * keeps the cache at ~8 MB instead of ~42 MB. Pass
   * `CardDatabase.allPrintingKeys()` from the Arena database. Omitting it
   * indexes everything, which is correct but large.
   *
   * A cache built for a different key set is treated as stale and rebuilt, so
   * the index follows Arena's card pool as new sets arrive.
   */
  wantedPrintings?: ReadonlySet<string>;
}

/** The subset of a Scryfall bulk card object we keep. */
interface RawBulkCard {
  arena_id?: unknown;
  name?: unknown;
  set?: unknown;
  set_name?: unknown;
  collector_number?: unknown;
  mana_cost?: unknown;
  cmc?: unknown;
  colors?: unknown;
  type_line?: unknown;
  rarity?: unknown;
  image_uris?: unknown;
  card_faces?: unknown;
}

interface BulkDataEntry {
  type?: unknown;
  download_uri?: unknown;
  jsonl_download_uri?: unknown;
  updated_at?: unknown;
}

interface BulkDataListResponse {
  data?: BulkDataEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Scryfall's bulk endpoint has been migrating to JSONL: `download_uri` is
 * gone on newer responses and `jsonl_download_uri` replaces it. Accept both.
 */
function bulkDownloadUri(entry: BulkDataEntry): string | null {
  for (const candidate of [entry.jsonl_download_uri, entry.download_uri]) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return null;
}

/**
 * Double-faced and split cards carry no top-level `image_uris`; the art lives
 * on the front face. A draft pack almost never contains one, but a deck can.
 */
function imageUris(card: RawBulkCard): Record<string, unknown> {
  if (isRecord(card.image_uris)) return card.image_uris;
  const faces = card.card_faces;
  if (Array.isArray(faces)) {
    for (const face of faces) {
      if (isRecord(face) && isRecord(face['image_uris'])) return face['image_uris'];
    }
  }
  return {};
}

function colorLetters(card: RawBulkCard): string {
  const direct = card.colors;
  if (Array.isArray(direct)) return direct.filter((c) => typeof c === 'string').join('');

  const faces = card.card_faces;
  if (Array.isArray(faces)) {
    const seen = new Set<string>();
    for (const face of faces) {
      if (!isRecord(face) || !Array.isArray(face['colors'])) continue;
      for (const color of face['colors']) {
        if (typeof color === 'string') seen.add(color);
      }
    }
    return [...seen].join('');
  }
  return '';
}

/**
 * Folds a raw Scryfall card into the compact tuple.
 *
 * A card is kept if it has an `arena_id` (indexed by grpId) *or* a set code
 * and collector number (indexed as a printing). Dropping the second kind is
 * what used to make a set Scryfall had already published — at prerelease —
 * look like it didn't exist, purely because its Arena ids hadn't landed yet.
 */
function toCompactCard(
  card: RawBulkCard,
): { grpId: number | null; printing: string | null; tuple: CompactCard } | null {
  const name = str(card.name);
  if (name.length === 0) return null;

  const rawArenaId = card.arena_id;
  const grpId =
    typeof rawArenaId === 'number' && Number.isFinite(rawArenaId) ? Math.trunc(rawArenaId) : null;

  const setCode = str(card.set).toUpperCase();
  const collectorNumber = str(card.collector_number);
  const printing =
    setCode.length > 0 && collectorNumber.length > 0
      ? printingKey(setCode, collectorNumber)
      : null;

  if (grpId === null && printing === null) return null;

  const images = imageUris(card);

  return {
    grpId,
    printing,
    tuple: [
      name,
      str(card.set_name),
      setCode,
      collectorNumber,
      str(card.mana_cost),
      num(card.cmc),
      colorLetters(card),
      str(card.type_line),
      str(card.rarity),
      str(images['small']),
      str(images['normal']),
    ],
  };
}

function looksGzipByMagicBytes(buffer: Buffer): boolean {
  return buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
}

/**
 * Streams the bulk file through gunzip and a line reader, yielding parsed
 * cards one at a time. The decompressed JSONL is hundreds of megabytes, so it
 * is never materialized as a single string.
 */
async function* iterateJsonLines(source: Readable): AsyncGenerator<RawBulkCard> {
  const gunzip = createGunzip();
  const decompressed = source.pipe(gunzip);
  const rl = createInterface({ input: decompressed, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (isRecord(parsed)) yield parsed as RawBulkCard;
    }
  } finally {
    rl.close();
    decompressed.destroy();
  }
}

async function* iterateJsonArray(text: string): AsyncGenerator<RawBulkCard> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return;
  }
  if (!Array.isArray(parsed)) return;
  for (const item of parsed) {
    if (isRecord(item)) yield item as RawBulkCard;
  }
}

interface BulkTarget {
  uri: string;
  updatedAt: string;
}

async function discoverBulkTarget(fetchImpl: typeof fetch, signal?: AbortSignal): Promise<BulkTarget> {
  const res = await fetchImpl(BULK_DATA_URL, { headers: REQUEST_HEADERS, ...(signal ? { signal } : {}) });
  if (!res.ok) {
    throw new Error(`Scryfall /bulk-data request failed: ${res.status} ${res.statusText}`);
  }

  let body: BulkDataListResponse;
  try {
    body = (await res.json()) as BulkDataListResponse;
  } catch (err) {
    throw new Error(`Scryfall /bulk-data response was not valid JSON: ${(err as Error).message}`);
  }

  const entry = body.data?.find((e) => e.type === 'default_cards');
  const uri = entry === undefined ? null : bulkDownloadUri(entry);
  if (uri === null) {
    throw new Error('Scryfall /bulk-data response has no default_cards entry with a download URI');
  }

  return { uri, updatedAt: str(entry?.updated_at) };
}

/**
 * Downloads Scryfall's default_cards bulk file and folds it into a
 * grpId → CardInfo map.
 *
 * The file is a gzipped JSONL stream and is consumed as a stream end to end,
 * so memory stays proportional to the *result* (~35k cards) rather than to the
 * download.
 */
export async function fetchCardDatabase(
  fetchImpl: typeof fetch,
  onProgress: (state: CardDbState) => void,
  signal?: AbortSignal,
  wantedPrintings?: ReadonlySet<string>,
): Promise<CardDatabase> {
  onProgress({
    phase: 'checking',
    receivedBytes: 0,
    totalBytes: null,
    cardCount: 0,
    source: 'scryfall',
    message: null,
  });
  const target = await discoverBulkTarget(fetchImpl, signal);

  const res = await fetchImpl(target.uri, { headers: REQUEST_HEADERS, ...(signal ? { signal } : {}) });
  if (!res.ok) {
    throw new Error(`Scryfall bulk download failed: ${res.status} ${res.statusText}`);
  }

  const lengthHeader = res.headers.get('content-length');
  const totalBytes = lengthHeader === null ? null : Number(lengthHeader);
  const knownTotal = totalBytes !== null && Number.isFinite(totalBytes) ? totalBytes : null;

  const cards = new Map<number, CardInfo>();
  const printings = new Map<string, CardFields>();
  let lastReport = 0;
  let received = 0;

  const report = (phase: CardDbState['phase'], force = false): void => {
    const now = Date.now();
    if (!force && now - lastReport < PROGRESS_INTERVAL_MS) return;
    lastReport = now;
    onProgress({
      phase,
      receivedBytes: received,
      totalBytes: knownTotal,
      cardCount: cards.size,
      source: 'scryfall',
      message: null,
    });
  };

  const add = (raw: RawBulkCard): void => {
    const compact = toCompactCard(raw);
    if (compact === null) return;

    // A card with an arena_id is already reachable by grpId; indexing it as a
    // printing too would only duplicate it.
    if (compact.grpId !== null) {
      cards.set(compact.grpId, decodeCompactCard(compact.grpId, compact.tuple));
      return;
    }

    if (compact.printing === null) return;
    if (wantedPrintings !== undefined && !wantedPrintings.has(compact.printing)) return;
    printings.set(compact.printing, decodeCardFields(compact.tuple));
  };

  report('downloading', true);

  const contentType = res.headers.get('content-type') ?? '';
  const gzipped = target.uri.toLowerCase().endsWith('.gz') || contentType.includes('gzip');

  if (gzipped) {
    if (res.body === null) throw new Error('Scryfall bulk download had no body to stream');

    // Count bytes off the wire with a pass-through, so the download loop and
    // the parse loop can run concurrently without fighting over the stream.
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        report('downloading');
        callback(null, chunk);
      },
    });

    const counted = Readable.fromWeb(res.body as never).pipe(counter);

    for await (const card of iterateJsonLines(counted)) {
      add(card);
      report('parsing');
    }
    received = Math.max(received, 0);
  } else {
    // Not obviously gzip by URI/headers — buffer the raw bytes and fall back
    // to a magic-byte check before deciding how to parse it.
    const buffer = Buffer.from(await res.arrayBuffer());
    received = buffer.length;
    report('parsing', true);

    const lines = looksGzipByMagicBytes(buffer)
      ? iterateJsonLines(Readable.from(buffer))
      : iterateJsonArray(buffer.toString('utf8'));

    for await (const card of lines) {
      add(card);
      report('parsing');
    }
  }

  if (cards.size === 0) {
    throw new Error('Scryfall bulk data contained no Arena cards');
  }

  const database = new CardDatabase(cards, printings)
    .withUpdatedAt(target.updatedAt)
    .withPrintingKeys(wantedPrintings === undefined ? '' : fingerprintKeys(wantedPrintings));
  onProgress({
    phase: 'ready',
    receivedBytes: received,
    totalBytes: knownTotal,
    cardCount: cards.size,
    source: 'scryfall',
    message: null,
  });
  return database;
}

function cacheFilePath(cacheDir: string): string {
  return path.join(cacheDir, CACHE_FILE_NAME);
}

async function readCache(cacheDir: string): Promise<CardDatabase | null> {
  let raw: string;
  try {
    raw = await readFile(cacheFilePath(cacheDir), 'utf8');
  } catch {
    return null;
  }
  try {
    return databaseFromCache(JSON.parse(raw));
  } catch {
    return null;
  }
}

async function writeCache(cacheDir: string, database: CardDatabase): Promise<void> {
  await mkdir(cacheDir, { recursive: true });
  await writeFile(cacheFilePath(cacheDir), JSON.stringify(database.toCache()), 'utf8');
}

/**
 * Loads the grpId → card map, preferring the on-disk cache.
 *
 * With `forceRefresh: false` (the default) this either returns almost
 * instantly from cache or performs the one-time bulk download. Callers are
 * expected to run it in the background: until it resolves, drafts still track
 * correctly, they just show raw Arena ids instead of names and art.
 */
export async function loadCardDatabase(
  options: LoadCardDatabaseOptions,
): Promise<CardDatabase> {
  const {
    cacheDir,
    forceRefresh = false,
    fetchImpl = globalThis.fetch,
    onProgress,
    signal,
    wantedPrintings,
  } = options;

  const report = onProgress ?? ((): void => {});

  // A cache built for a different set of wanted keys predates a change in
  // Arena's card pool, so its printing index is missing entries we now need.
  const wantedFingerprint =
    wantedPrintings === undefined ? '' : fingerprintKeys(wantedPrintings);

  if (!forceRefresh) {
    const cached = await readCache(cacheDir);
    if (cached !== null && cached.printingKeys === wantedFingerprint) {
      report({
        phase: 'ready',
        receivedBytes: 0,
        totalBytes: null,
        cardCount: cached.size,
        source: 'scryfall',
        message: null,
      });
      return cached;
    }
  }

  try {
    const database = await fetchCardDatabase(fetchImpl, report, signal, wantedPrintings);
    await writeCache(cacheDir, database);
    return database;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    report({
      phase: 'error',
      receivedBytes: 0,
      totalBytes: null,
      cardCount: 0,
      source: null,
      message: `Could not download card art: ${message}. Card names still come from MTG Arena.`,
    });
    throw err;
  }
}

export { CACHE_VERSION, CACHE_FILE_NAME };
