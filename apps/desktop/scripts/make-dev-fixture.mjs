/**
 * Builds a self-contained dev fixture for the web UI: real drafts plus the
 * real card data for every card they mention.
 *
 * It lets `pnpm dev` render the whole UI in a plain browser — no Electron, no
 * Arena, no 79 MB download — which is how the design gets iterated on.
 *
 * Two drafts are produced on purpose:
 *   1. the draft captured in the arena package's log fixture, named from
 *      MTGA's own card database (this is what a brand-new set looks like:
 *      names but no art);
 *   2. a synthetic completed draft from a set Scryfall knows, so the art-led
 *      layout and the deck panel have something to render.
 *
 *   pnpm build && node apps/desktop/scripts/make-dev-fixture.mjs
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DraftTracker } from '@drafttracker/arena';
import {
  CACHE_FILE_NAME,
  databaseFromCache,
  findArenaCardDatabasePath,
  loadArenaCardDatabase,
} from '@drafttracker/cards';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

const LOG_FIXTURE = path.join(repoRoot, 'packages/arena/test/fixtures/draft-session.log');
const SCRYFALL_CACHE = path.join(repoRoot, '.cache', CACHE_FILE_NAME);
const OUT_DIR = path.join(repoRoot, 'apps/web/src/dev');
const OUT_FILE = path.join(OUT_DIR, 'fixture.json');

/** 42 picks across three 14-card packs. */
const PICKS_PER_PACK = 14;
const PACKS = 3;

function replay(logText) {
  let latest = null;
  const tracker = new DraftTracker({
    logPath: '/dev/null',
    onLive: (state) => {
      latest = state;
    },
    emitScheduler: (flush) => flush(),
  });
  tracker.ingestText(logText);
  if (latest === null || latest.draft === null) throw new Error('fixture log produced no draft');
  return latest.draft;
}

/**
 * Builds a plausible finished draft out of a real set, so the fixture
 * exercises the art path and the deck panel.
 */
function syntheticDraft(arenaDb, scryfall, setCode) {
  const pool = [];
  for (let grpId = 0; grpId < 200000; grpId += 1) {
    const card = arenaDb.get(grpId);
    if (card === undefined || card.set !== setCode) continue;
    if (card.typeLine.includes('Land') && card.rarity === 'common') continue;
    pool.push(card);
  }
  if (pool.length < PACKS * PICKS_PER_PACK * 3) {
    throw new Error(`set ${setCode} has too few cards for a synthetic draft`);
  }
  pool.sort((a, b) => a.id - b.id);

  const startedAt = Date.parse('2026-09-28T19:04:00Z');
  const picks = [];
  let cursor = 0;
  const picked = [];

  for (let pack = 1; pack <= PACKS; pack += 1) {
    for (let pick = 1; pick <= PICKS_PER_PACK; pick += 1) {
      const size = PICKS_PER_PACK - pick + 1;
      // Overlapping windows, so the same card shows up in several packs the
      // way a real draft's packs overlap.
      const cardsSeen = Array.from({ length: size }, (_, i) =>
        pool[(cursor + i * 3) % pool.length].id,
      );
      const choice = cardsSeen[Math.floor(pick / 2) % cardsSeen.length];
      picked.push(choice);
      picks.push({
        pack,
        pick,
        cardsSeen,
        picked: choice,
        seenAt: startedAt + picks.length * 45_000,
        pickedAt: startedAt + picks.length * 45_000 + 12_000,
      });
      cursor += 1;
    }
  }

  const counts = new Map();
  for (const grpId of picked) counts.set(grpId, (counts.get(grpId) ?? 0) + 1);

  const entries = [...counts.entries()]
    .map(([grpId, quantity]) => ({ grpId, quantity }))
    .sort((a, b) => b.quantity - a.quantity);

  const mainDeck = entries.filter((e) => {
    const card = scryfall.get(e.grpId) ?? arenaDb.get(e.grpId);
    return card !== undefined && !card.typeLine.includes('Land');
  }).slice(0, 23);
  const lands = entries.filter((e) => {
    const card = scryfall.get(e.grpId) ?? arenaDb.get(e.grpId);
    return card !== undefined && card.typeLine.includes('Land');
  });

  const withLands = [...mainDeck, ...lands].slice(0, 26);

  return {
    draftId: 'dev-fixture-synthetic',
    eventName: `PremierDraft_${setCode}_20260928`,
    setCode,
    isBotDraft: false,
    startedAt,
    updatedAt: startedAt + 42 * 45_000 + 600_000,
    status: 'complete',
    picks,
    deck: {
      deckId: 'dev-fixture-deck',
      name: 'Draft Deck',
      mainDeck: withLands,
      sideboard: entries.filter((e) => !withLands.some((m) => m.grpId === e.grpId)).slice(0, 14),
      capturedAt: startedAt + 42 * 45_000 + 400_000,
    },
  };
}

/** Picks a set Scryfall has plenty of art for. */
function chooseArtSet(arenaDb, scryfall) {
  const bySet = new Map();
  for (let grpId = 0; grpId < 200000; grpId += 1) {
    const card = scryfall.get(grpId);
    if (card === undefined || card.imageSmall === null) continue;
    const arena = arenaDb.get(grpId);
    if (arena === undefined) continue;
    const set = arena.set;
    if (set.length === 0) continue;
    bySet.set(set, (bySet.get(set) ?? 0) + 1);
  }

  let best = null;
  for (const [set, count] of bySet) {
    if (count >= PICKS_PER_PACK * PACKS * 3 && (best === null || count > best.count)) {
      best = { set, count };
    }
  }
  if (best === null) throw new Error('the Scryfall cache has no set big enough for a fixture');
  return best.set;
}

function referencedIds(draft) {
  const ids = new Set();
  for (const pick of draft.picks) {
    for (const id of pick.cardsSeen) ids.add(id);
    if (pick.picked !== null) ids.add(pick.picked);
  }
  for (const entry of draft.deck?.mainDeck ?? []) ids.add(entry.grpId);
  for (const entry of draft.deck?.sideboard ?? []) ids.add(entry.grpId);
  return [...ids];
}

function main() {
  console.log('replaying the captured draft log…');
  const captured = replay(readFileSync(LOG_FIXTURE, 'utf8'));
  console.log(`  ${captured.picks.length} picks from ${captured.eventName}`);

  const arenaPath = findArenaCardDatabasePath();
  if (arenaPath === null) {
    throw new Error('MTG Arena’s card database was not found — run Arena once first');
  }
  console.log(`loading Arena's card database (${path.basename(arenaPath)})…`);
  const arenaDb = loadArenaCardDatabase(arenaPath);
  console.log(`  ${arenaDb.size} cards`);

  // Fold Scryfall into Arena's database through the same merge the app uses,
  // so the fixture exercises the real printing-index fallback rather than a
  // simplified copy of it.
  let scryfall = null;
  try {
    scryfall = databaseFromCache(JSON.parse(readFileSync(SCRYFALL_CACHE, 'utf8')));
  } catch {
    scryfall = null;
  }
  if (scryfall === null) {
    console.warn('  no Scryfall cache found; the fixture will have no card art');
  } else {
    const upgraded = arenaDb.enrichFrom(scryfall);
    console.log(
      `  ${scryfall.size} cards + ${scryfall.printingCount} printings from Scryfall; ${upgraded} upgraded`,
    );
  }

  const artSet = scryfall !== null ? chooseArtSet(arenaDb, scryfall) : null;
  if (artSet !== null) console.log(`  building a synthetic ${artSet} draft for art coverage`);

  const drafts = [captured];
  if (artSet !== null) drafts.push(syntheticDraft(arenaDb, scryfall, artSet));

  const cards = {};
  for (const draft of drafts) {
    for (const id of referencedIds(draft)) {
      const arena = arenaDb.get(id);
      const art = scryfall === null ? undefined : scryfall.get(id);
      const merged = arena === undefined ? art : { ...arena, ...(art ?? {}) };
      if (merged !== undefined) cards[id] = merged;
    }
  }

  const missing = drafts
    .flatMap(referencedIds)
    .filter((id) => cards[id] === undefined).length;
  if (missing > 0) console.warn(`  ${missing} card references had no data at all`);

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify({ drafts, cards }), 'utf8');
  const kb = (readFileSync(OUT_FILE).length / 1024).toFixed(0);
  console.log(
    `wrote ${path.relative(repoRoot, OUT_FILE)} (${kb} KB, ${Object.keys(cards).length} cards)`,
  );
}

main();
