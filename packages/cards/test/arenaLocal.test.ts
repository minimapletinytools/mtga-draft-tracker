import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CardDatabase } from '../src/database.js';
import {
  arenaCardDatabaseDirs,
  findArenaCardDatabasePath,
  loadArenaCardDatabase,
} from '../src/arenaLocal.js';

/**
 * The real MTGA card database is 250 MB and only exists on a machine with
 * Arena installed, so these tests build a miniature one with the same schema
 * using the `sqlite3` CLI. Skipped where the CLI isn't available.
 */
function hasSqliteCli(): boolean {
  try {
    execFileSync('sqlite3', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const SCHEMA = `
CREATE TABLE Cards(
  GrpId INT UNIQUE PRIMARY KEY NOT NULL,
  TitleId INT NOT NULL,
  ExpansionCode TEXT,
  DigitalReleaseSet TEXT,
  CollectorNumber TEXT NOT NULL,
  Rarity INT NOT NULL,
  Colors TEXT NOT NULL,
  Types TEXT NOT NULL
);
CREATE TABLE Localizations_enUS(LocId INT NOT NULL, Formatted INT NOT NULL, Loc TEXT, PRIMARY KEY (LocId, Formatted));
`;

const FIXTURE_ROWS = `
INSERT INTO Cards VALUES (106333, 100, 'FRA', 'FRA', '100', 2, '5', '2');
INSERT INTO Cards VALUES (106227, 101, 'FRA', 'FRA', '3',   2, '1', '2');
INSERT INTO Cards VALUES (106225, 102, 'FRA', 'FRA', '1',   5, '',  '2');
INSERT INTO Cards VALUES (106535, 103, 'FRA', 'FRA', '290', 1, '5', '5');
INSERT INTO Cards VALUES (106413, 104, 'FRA', 'FRA', '168', 4, '',  '1,2');
INSERT INTO Cards VALUES (106394, 105, 'FRA', 'FRA', '153', 2, '2,5', '10');
-- No English localization at all: must be skipped, not crash.
INSERT INTO Cards VALUES (999999, 106, 'FRA', 'FRA', '999', 2, '1', '2');

INSERT INTO Localizations_enUS VALUES (100, 0, 'Carnivorous Cultivator');
-- Arena wraps some names in Unity rich-text tags; the plain form is absent.
INSERT INTO Localizations_enUS VALUES (101, 1, '<nobr>Blossom-Blessed</nobr> Angel');
INSERT INTO Localizations_enUS VALUES (102, 1, 'Emrakul, the Exigent Doom');
INSERT INTO Localizations_enUS VALUES (103, 0, 'Forest');
INSERT INTO Localizations_enUS VALUES (104, 0, 'Codie, Ravenous Codex');
INSERT INTO Localizations_enUS VALUES (105, 0, "Tam's Resistance");
`;

describe.skipIf(!hasSqliteCli())('loadArenaCardDatabase', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'arena-db-'));
  const dbPath = path.join(dir, 'Raw_CardDatabase_test.mtga');

  execFileSync('sqlite3', [dbPath], { input: `${SCHEMA}${FIXTURE_ROWS}` });

  const db = loadArenaCardDatabase(dbPath);

  it('reads names out of Arena’s own database', () => {
    expect(db.get(106333)?.name).toBe('Carnivorous Cultivator');
    expect(db.get(106535)?.name).toBe('Forest');
    expect(db.get(106394)?.name).toBe("Tam's Resistance");
    expect(db.size).toBe(6);
  });

  it('strips Unity rich-text markup from names', () => {
    expect(db.get(106227)?.name).toBe('Blossom-Blessed Angel');
  });

  it('maps Arena’s rarity enum', () => {
    expect(db.get(106535)?.rarity).toBe('common'); // 1 = basic land
    expect(db.get(106333)?.rarity).toBe('common'); // 2
    expect(db.get(106225)?.rarity).toBe('mythic'); // 5
    expect(db.get(106413)?.rarity).toBe('rare'); // 4
  });

  it('decodes colours and card types', () => {
    expect(db.get(106333)?.colors).toEqual(['G']);
    expect(db.get(106394)?.colors).toEqual(['U', 'G']);
    expect(db.get(106394)?.typeLine).toBe('Sorcery');
    expect(db.get(106413)?.typeLine).toBe('Artifact Creature');
    expect(db.get(106535)?.typeLine).toBe('Land');
  });

  it('reports that it has no art or mana cost', () => {
    const card = db.get(106333);
    expect(card?.source).toBe('arena');
    expect(card?.manaCost).toBe('');
    expect(card?.imageSmall).toBeNull();
  });

  it('leaves cards alone when the incoming data adds nothing', () => {
    // Arena-only data has no art or mana cost, so re-merging it is a no-op.
    expect(db.enrichFrom(loadArenaCardDatabase(dbPath))).toBe(0);
  });

  it('lets Scryfall data fill in the gaps', () => {
    const scryfall = new CardDatabase(
      new Map([
        [
          106333,
          {
            id: 106333,
            name: 'Carnivorous Cultivator',
            set: 'FRA',
            setName: 'Reality Fracture',
            collectorNumber: '100',
            manaCost: '{2}{G}{G}',
            cmc: 4,
            colors: ['G' as const],
            typeLine: 'Creature — Plant',
            rarity: 'uncommon' as const,
            imageSmall: 'https://cards.scryfall.io/small/front/aa.jpg',
            imageNormal: 'https://cards.scryfall.io/normal/front/aa.jpg',
            source: 'scryfall' as const,
          },
        ],
        [
          107001,
          {
            id: 107001,
            name: 'A Card Arena Has Not Shipped',
            set: 'FRA',
            setName: 'Reality Fracture',
            collectorNumber: '999',
            manaCost: '{1}',
            cmc: 1,
            colors: [],
            typeLine: 'Artifact',
            rarity: 'common' as const,
            imageSmall: null,
            imageNormal: null,
            source: 'scryfall' as const,
          },
        ],
      ]),
    );

    expect(db.enrichFrom(scryfall)).toBe(2);

    const upgraded = db.get(106333);
    expect(upgraded?.manaCost).toBe('{2}{G}{G}');
    expect(upgraded?.imageNormal).toContain('/normal/');
    expect(upgraded?.source).toBe('scryfall');
    // Arena's own facts survive the merge.
    expect(upgraded?.name).toBe('Carnivorous Cultivator');
    expect(upgraded?.rarity).toBe('common');

    // A card only Scryfall knows about is added.
    expect(db.get(107001)?.name).toBe('A Card Arena Has Not Shipped');
    expect(db.size).toBe(7);
  });

  it('finds the newest database file for the platform', () => {
    expect(arenaCardDatabaseDirs('darwin', '/Users/someone')).toEqual([
      '/Users/someone/Library/Application Support/com.wizards.mtga/Downloads/Raw',
    ]);
    expect(arenaCardDatabaseDirs('linux', '/home/someone')).toEqual([]);

    const found = findArenaCardDatabasePath('darwin', path.dirname(path.dirname(dir)));
    // The temp dir isn't Arena's, so this is the "not installed" path.
    expect(found).toBeNull();
  });

  it('finds the file when the platform directory holds one', () => {
    const fakeHome = mkdtempSync(path.join(tmpdir(), 'home-'));
    const rawDir = path.join(fakeHome, 'Library/Application Support/com.wizards.mtga/Downloads/Raw');
    execFileSync('mkdir', ['-p', rawDir]);
    execFileSync('cp', [dbPath, path.join(rawDir, 'Raw_CardDatabase_abc.mtga')]);

    const found = findArenaCardDatabasePath('darwin', fakeHome);
    expect(found).toBe(path.join(rawDir, 'Raw_CardDatabase_abc.mtga'));
    expect(loadArenaCardDatabase(found as string).size).toBe(6);

    rmSync(fakeHome, { recursive: true, force: true });
  });

  it('throws rather than returning nonsense for a file that is not a database', () => {
    const bogus = path.join(dir, 'not-a-db.mtga');
    execFileSync('touch', [bogus]);
    expect(existsSync(bogus)).toBe(true);
    expect(() => loadArenaCardDatabase(bogus)).toThrow();
  });
});
