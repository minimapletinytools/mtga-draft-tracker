import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import type { CardDbState } from '@drafttracker/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CardDatabase, databaseFromCache } from '../src/database.js';
import { loadCardDatabase } from '../src/scryfall.js';

/** Minimal Scryfall card objects, shaped like the real bulk entries. */
const CARDS = [
  {
    arena_id: 106333,
    name: 'Lightning Strike',
    set: 'fra',
    set_name: 'Foundations Arena',
    collector_number: '146',
    mana_cost: '{1}{R}',
    cmc: 2,
    colors: ['R'],
    type_line: 'Instant',
    rarity: 'common',
    image_uris: {
      small: 'https://cards.scryfall.io/small/front/a/b/ab.jpg',
      normal: 'https://cards.scryfall.io/normal/front/a/b/ab.jpg',
    },
  },
  {
    // Double-faced: no top-level image_uris, colors only on the faces.
    arena_id: 106334,
    name: 'Fable // Reflection',
    set: 'fra',
    set_name: 'Foundations Arena',
    collector_number: '200',
    cmc: 3,
    type_line: 'Creature // Creature',
    rarity: 'rare',
    card_faces: [
      {
        colors: ['R'],
        image_uris: {
          small: 'https://cards.scryfall.io/small/front/c/d/cd.jpg',
          normal: 'https://cards.scryfall.io/normal/front/c/d/cd.jpg',
        },
      },
      { colors: ['R', 'G'] },
    ],
  },
  {
    // A card with no Arena id at all — must be skipped.
    name: 'Paper Only Card',
    set: 'xln',
    cmc: 1,
    colors: ['U'],
    rarity: 'common',
  },
];

function gzippedJsonl(cards: unknown[]): Buffer {
  return gzipSync(Buffer.from(cards.map((card) => JSON.stringify(card)).join('\n') + '\n'));
}

describe('loadCardDatabase', () => {
  let dir: string;
  let server: Server;
  let baseUrl: string;
  let bulkHits: number;
  let downloadHits: number;
  let failDownload: boolean;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'cards-'));
    bulkHits = 0;
    downloadHits = 0;
    failDownload = false;

    const payload = gzippedJsonl(CARDS);

    server = createServer((req, res) => {
      if (req.url === '/bulk-data') {
        bulkHits++;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            data: [
              { type: 'oracle_cards', jsonl_download_uri: `${baseUrl}/oracle.jsonl.gz` },
              {
                type: 'default_cards',
                jsonl_download_uri: `${baseUrl}/default.jsonl.gz`,
                updated_at: '2026-10-06T21:05:46.306+00:00',
                compressed_size: payload.length,
              },
            ],
          }),
        );
        return;
      }

      if (req.url === '/default.jsonl.gz') {
        downloadHits++;
        if (failDownload) {
          res.writeHead(500);
          res.end('nope');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/gzip', 'content-length': String(payload.length) });
        res.end(payload);
        return;
      }

      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });

  /**
   * A fetch that rewrites Scryfall's real URLs to the local test server, so the
   * loader's own URL handling is still exercised.
   */
  function testFetch(): typeof fetch {
    return ((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const rewritten = url
        .replace('https://api.scryfall.com/bulk-data', `${baseUrl}/bulk-data`)
        .replace('https://data.scryfall.io/default-cards/x.jsonl.gz', `${baseUrl}/default.jsonl.gz`)
        .replace(`${baseUrl}/oracle.jsonl.gz`, `${baseUrl}/oracle.jsonl.gz`);
      return fetch(rewritten, init);
    }) as typeof fetch;
  }

  it('downloads, parses and indexes Arena cards', async () => {
    const states: CardDbState[] = [];
    const db = await loadCardDatabase({
      cacheDir: dir,
      fetchImpl: testFetch(),
      onProgress: (state) => states.push(state),
    });

    expect(db.size).toBe(2);
    expect(db.get(106333)?.name).toBe('Lightning Strike');
    expect(db.get(106333)?.set).toBe('FRA');
    expect(db.get(106333)?.manaCost).toBe('{1}{R}');
    expect(db.get(106333)?.colors).toEqual(['R']);
    expect(db.get(106333)?.imageNormal).toContain('/normal/');
    expect(db.get(999999)).toBeUndefined();

    // Double-faced cards still get art and colors.
    expect(db.get(106334)?.imageSmall).toContain('/small/');
    expect(db.get(106334)?.colors).toEqual(['R', 'G']);

    expect(states.map((s) => s.phase)).toContain('checking');
    expect(states.map((s) => s.phase)).toContain('downloading');
    expect(states.at(-1)?.phase).toBe('ready');
    expect(states.at(-1)?.cardCount).toBe(2);
    expect(db.updatedAt).toBe('2026-10-06T21:05:46.306+00:00');
  });

  it('serves a second load from cache without touching the network', async () => {
    await loadCardDatabase({ cacheDir: dir, fetchImpl: testFetch() });
    expect(bulkHits).toBe(1);
    expect(downloadHits).toBe(1);

    const states: CardDbState[] = [];
    const cached = await loadCardDatabase({
      cacheDir: dir,
      fetchImpl: testFetch(),
      onProgress: (state) => states.push(state),
    });

    expect(bulkHits).toBe(1);
    expect(downloadHits).toBe(1);
    expect(cached.size).toBe(2);
    expect(states.at(-1)?.phase).toBe('ready');
  });

  it('re-downloads when forced', async () => {
    await loadCardDatabase({ cacheDir: dir, fetchImpl: testFetch() });
    await loadCardDatabase({ cacheDir: dir, fetchImpl: testFetch(), forceRefresh: true });
    expect(downloadHits).toBe(2);
  });

  it('reports an error state and rethrows when the download fails', async () => {
    failDownload = true;
    const states: CardDbState[] = [];

    await expect(
      loadCardDatabase({
        cacheDir: dir,
        fetchImpl: testFetch(),
        onProgress: (state) => states.push(state),
        // Cache is empty, so this genuinely has to download.
        forceRefresh: true,
      }),
    ).rejects.toThrow(/bulk download failed/);

    const last = states.at(-1);
    expect(last?.phase).toBe('error');
    expect(last?.message).toMatch(/Card names still come from MTG Arena/);
  });

  it('writes a cache file that round-trips', async () => {
    await loadCardDatabase({ cacheDir: dir, fetchImpl: testFetch() });
    const raw = JSON.parse(await readFile(path.join(dir, 'cards.json'), 'utf8'));
    const rebuilt = databaseFromCache(raw);
    expect(rebuilt?.size).toBe(2);
    expect(rebuilt?.get(106333)?.name).toBe('Lightning Strike');
  });
});

describe('databaseFromCache', () => {
  it('rejects a cache from an older layout', () => {
    expect(databaseFromCache({ version: 1, cards: { '1': [] } })).toBeNull();
    expect(databaseFromCache(null)).toBeNull();
    expect(databaseFromCache({ version: 2, cards: {} })).toBeNull();
    expect(databaseFromCache({ version: 2, cards: { '1': ['too', 'short'] } })).toBeNull();
  });
});

describe('CardDatabase', () => {
  it('picks out exactly the requested cards', () => {
    const db = new CardDatabase(
      new Map([
        [
          1,
          {
            id: 1,
            name: 'A',
            set: 'FRA',
            setName: 'Foundations Arena',
            collectorNumber: '1',
            manaCost: '',
            cmc: 0,
            colors: [],
            typeLine: 'Land',
            rarity: 'common' as const,
            imageSmall: null,
            imageNormal: null,
            source: 'scryfall' as const,
          },
        ],
      ]),
    );

    expect(db.pick([1, 2, 3])).toEqual({ 1: db.get(1) });
    expect(db.setForCard(1)).toBe('FRA');
    expect(db.setForCard(2)).toBeNull();
  });
});
