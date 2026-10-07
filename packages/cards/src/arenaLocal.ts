import { readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { CardInfo, Color, Rarity } from '@drafttracker/core';
import { CardDatabase } from './database.js';

/**
 * MTGA ships its entire card database as a plain SQLite file, refreshed by the
 * client on every patch. It has no art and no mana costs, but it is *current*:
 * Scryfall's `arena_id` values lag a set release by days, which is exactly the
 * window in which people are drafting the new set.
 *
 * So this is the first layer: it makes every grpId readable immediately, and
 * Scryfall later upgrades what it can.
 */

/** MTGA's card type enum, as stored in `Cards.Types`. */
const CARD_TYPES: Record<number, string> = {
  1: 'Artifact',
  2: 'Creature',
  3: 'Enchantment',
  4: 'Instant',
  5: 'Land',
  6: 'Phenomenon',
  7: 'Plane',
  8: 'Planeswalker',
  9: 'Scheme',
  10: 'Sorcery',
  11: 'Kindred',
  12: 'Vanguard',
  13: 'Dungeon',
  14: 'Battle',
  15: 'Conspiracy',
};

/** `Cards.Colors` uses the CardColor enum, 1-5. */
const CARD_COLORS: Record<number, Color> = { 1: 'W', 2: 'U', 3: 'B', 4: 'R', 5: 'G' };

/** `Cards.Rarity`: 1=basic land, 2=common, 3=uncommon, 4=rare, 5=mythic. */
const CARD_RARITIES: Record<number, Rarity> = {
  0: 'common',
  1: 'common',
  2: 'common',
  3: 'uncommon',
  4: 'rare',
  5: 'mythic',
};

/** Arena wraps some localised strings in Unity rich-text tags. */
function stripMarkup(value: string): string {
  return value.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

function decodeCsvEnum(raw: string, table: Record<number, string>): string[] {
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    const value = Number(trimmed);
    if (!Number.isFinite(value)) continue;
    const name = table[value];
    if (name !== undefined) out.push(name);
  }
  return out;
}

function decodeColors(raw: string): Color[] {
  const out: Color[] = [];
  for (const part of raw.split(',')) {
    const value = Number(part.trim());
    const color = CARD_COLORS[value];
    if (color !== undefined && !out.includes(color)) out.push(color);
  }
  return out;
}

/** Candidate locations for `Raw_CardDatabase_*.mtga`, best-effort per platform. */
export function arenaCardDatabaseDirs(
  platform: NodeJS.Platform = process.platform,
  homeDir: string = os.homedir(),
): string[] {
  if (platform === 'darwin') {
    return [path.join(homeDir, 'Library/Application Support/com.wizards.mtga/Downloads/Raw')];
  }
  if (platform === 'win32') {
    const localAppData = process.env['LOCALAPPDATA'] ?? path.join(homeDir, 'AppData', 'Local');
    return [
      // The game's own data directory, wherever it was installed.
      'C:\\Program Files\\Wizards of the Coast\\MTGA\\MTGA_Data\\Downloads\\Raw',
      path.join(localAppData, 'Wizards of the Coast', 'MTGA', 'MTGA_Data', 'Downloads', 'Raw'),
      path.join(localAppData, 'MTGA', 'MTGA_Data', 'Downloads', 'Raw'),
    ];
  }
  return [];
}

/**
 * Finds the newest `Raw_CardDatabase_*.mtga`.
 *
 * Arena keeps exactly one, but a failed download can leave the previous one
 * behind, so pick by modification time rather than assuming a single file.
 */
export function findArenaCardDatabasePath(
  platform: NodeJS.Platform = process.platform,
  homeDir: string = os.homedir(),
): string | null {
  let best: { file: string; mtimeMs: number } | null = null;

  for (const dir of arenaCardDatabaseDirs(platform, homeDir)) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }

    for (const name of names) {
      if (!/^Raw_CardDatabase_.*\.mtga$/i.test(name)) continue;
      const file = path.join(dir, name);
      try {
        const stats = statSync(file);
        if (!stats.isFile()) continue;
        if (best === null || stats.mtimeMs > best.mtimeMs) {
          best = { file, mtimeMs: stats.mtimeMs };
        }
      } catch {
        /* unreadable entry — skip */
      }
    }
  }

  return best?.file ?? null;
}

interface CardRow {
  GrpId: number;
  Loc: string | null;
  LocMarkup: string | null;
  ExpansionCode: string | null;
  DigitalReleaseSet: string | null;
  CollectorNumber: string | null;
  Rarity: number;
  Colors: string | null;
  Types: string | null;
}

/**
 * Reads Arena's card database into a CardDatabase.
 *
 * ~27,000 rows, loaded in one query: a single pass beats per-card lookups by
 * three orders of magnitude, and 27k card records is a few megabytes.
 *
 * Throws if the file can't be opened — callers treat that as "no local card
 * data" and carry on with Scryfall alone.
 */
export function loadArenaCardDatabase(dbPath: string): CardDatabase {
  const db = new DatabaseSync(dbPath, { readOnly: true });

  try {
    // Names come in three flavours per LocId: 0 is plain text, 1 may carry
    // Unity rich-text tags, 2 is a shortened form. Prefer 0, fall back to 1.
    const rows = db
      .prepare(
        `SELECT
           c.GrpId                AS GrpId,
           plain.Loc              AS Loc,
           markupped.Loc          AS LocMarkup,
           c.ExpansionCode        AS ExpansionCode,
           c.DigitalReleaseSet    AS DigitalReleaseSet,
           c.CollectorNumber      AS CollectorNumber,
           c.Rarity               AS Rarity,
           c.Colors               AS Colors,
           c.Types                AS Types
         FROM Cards c
         LEFT JOIN Localizations_enUS plain
           ON plain.LocId = c.TitleId AND plain.Formatted = 0
         LEFT JOIN Localizations_enUS markupped
           ON markupped.LocId = c.TitleId AND markupped.Formatted = 1`,
      )
      .all() as unknown as CardRow[];

    const cards = new Map<number, CardInfo>();

    for (const row of rows) {
      const rawName = row.Loc ?? row.LocMarkup;
      if (rawName === null) continue;

      const name = stripMarkup(rawName);
      if (name.length === 0) continue;

      const types = decodeCsvEnum(row.Types ?? '', CARD_TYPES);

      cards.set(row.GrpId, {
        id: row.GrpId,
        name,
        // DigitalReleaseSet is the Arena-only set (e.g. an Alchemy drop);
        // ExpansionCode is the paper set. Prefer the paper code, which is what
        // players call the set.
        set: (row.ExpansionCode ?? row.DigitalReleaseSet ?? '').toUpperCase(),
        setName: '',
        collectorNumber: row.CollectorNumber ?? '',
        manaCost: '',
        cmc: 0,
        colors: decodeColors(row.Colors ?? ''),
        typeLine: types.join(' '),
        rarity: CARD_RARITIES[row.Rarity] ?? 'common',
        imageSmall: null,
        imageNormal: null,
        source: 'arena',
      });
    }

    return new CardDatabase(cards);
  } finally {
    db.close();
  }
}
