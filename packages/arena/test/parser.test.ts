import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseDraftEvent, parseGrpIdList, parseLogTimestamp } from '../src/parser.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/draft-session.log', import.meta.url));
const FIXTURE_LINES = readFileSync(FIXTURE, 'utf8').split('\n');

/** The one real log line containing `needle`, so tests run on Arena's output. */
function realLine(needle: string): string {
  const line = FIXTURE_LINES.find((candidate) => candidate.includes(needle));
  if (line === undefined) throw new Error(`fixture has no line containing ${needle}`);
  return line;
}

describe('parseLogTimestamp', () => {
  it('reads Arena’s bare timestamp lines', () => {
    const at = parseLogTimestamp('[UnityCrossThreadLogger]10/6/2026 5:58:06 PM');
    expect(at).toBe(new Date(2026, 9, 6, 17, 58, 6, 0).getTime());
  });

  it('handles midnight and noon correctly', () => {
    expect(parseLogTimestamp('[UnityCrossThreadLogger]1/2/2026 12:00:00 AM')).toBe(
      new Date(2026, 0, 2, 0, 0, 0, 0).getTime(),
    );
    expect(parseLogTimestamp('[UnityCrossThreadLogger]1/2/2026 12:30:00 PM')).toBe(
      new Date(2026, 0, 2, 12, 30, 0, 0).getTime(),
    );
  });

  it('ignores anything that is not a timestamp line', () => {
    expect(parseLogTimestamp('[UnityCrossThreadLogger]Draft.Notify {}')).toBeNull();
    expect(parseLogTimestamp('UnityEngine.DebugLogHandler:Internal_Log()')).toBeNull();
    expect(parseLogTimestamp('[UnityCrossThreadLogger]13/45/2026 9:00:00 AM')).toBeNull();
  });
});

describe('parseGrpIdList', () => {
  it('splits a comma-separated PackCards value', () => {
    expect(parseGrpIdList('106394,106418,106417')).toEqual([106394, 106418, 106417]);
  });

  it('tolerates whitespace and junk', () => {
    expect(parseGrpIdList(' 1 , ,2,abc,3 ')).toEqual([1, 2, 3]);
    expect(parseGrpIdList('')).toEqual([]);
  });
});

describe('parseDraftEvent', () => {
  it('parses Draft.Notify into the pack that was seen', () => {
    const event = parseDraftEvent(realLine('Draft.Notify'));
    expect(event).toEqual({
      kind: 'pack',
      draftId: 'cb5c1e21-07d7-4bbf-9183-765664909bb3',
      pack: 1,
      pick: 1,
      cards: [
        106394, 106418, 106417, 106399, 106231, 106352, 106296, 106358, 106412, 106333, 106471,
        106455, 106512, 106529,
      ],
      at: null,
    });
  });

  it('parses EventPlayerDraftMakePick into the card that was taken', () => {
    const event = parseDraftEvent(realLine('==> EventPlayerDraftMakePick'));
    expect(event).toEqual({
      kind: 'make-pick',
      draftId: 'cb5c1e21-07d7-4bbf-9183-765664909bb3',
      pack: 1,
      pick: 1,
      grpIds: [106333],
      at: null,
    });
  });

  it('parses DraftCompleteDraft', () => {
    expect(parseDraftEvent(realLine('==> DraftCompleteDraft'))).toEqual({
      kind: 'draft-complete',
      eventName: 'PremierDraft_FRA_20260929',
      isBotDraft: false,
      at: null,
    });
  });

  it('parses the submitted deck out of EventSetDeckV3', () => {
    const event = parseDraftEvent(realLine('==> EventSetDeckV3'));
    expect(event?.kind).toBe('deck');
    if (event?.kind !== 'deck') throw new Error('expected a deck event');

    expect(event.eventName).toBe('PremierDraft_FRA_20260929');
    expect(event.deckId).toBe('d07ccce0-964e-4630-beb0-82d0ea29c550');
    expect(event.name).toBe('Draft Deck');

    const total = event.mainDeck.reduce((n, e) => n + e.quantity, 0);
    expect(total).toBe(40);
    expect(event.mainDeck).toContainEqual({ grpId: 106333, quantity: 2 });
    // Basic lands show up as high-quantity sideboard-ish entries.
    expect(event.mainDeck).toContainEqual({ grpId: 106535, quantity: 5 });
    expect(event.sideboard.length).toBeGreaterThan(0);
  });

  it('treats a PlayerDraft course as the start of a draft', () => {
    expect(parseDraftEvent(realLine('"CurrentModule":"PlayerDraft"'))).toEqual({
      kind: 'draft-start',
      eventName: 'PremierDraft_FRA_20260929',
      at: null,
    });
  });

  it('treats a draft DeckSelect course as the end of the picks', () => {
    const line = realLine('"CurrentModule":"DeckSelect"');
    const event = parseDraftEvent(line);
    expect(event?.kind).toBe('draft-complete');
    if (event?.kind !== 'draft-complete') throw new Error('expected completion');
    expect(event.eventName).toBe('PremierDraft_FRA_20260929');
  });

  it('does not treat a constructed course as a draft', () => {
    const line = FIXTURE_LINES.find(
      (candidate) => candidate.includes('Constructed_BestOf3') && candidate.includes('CurrentModule'),
    );
    expect(line).toBeDefined();
    expect(parseDraftEvent(line as string)).toBeNull();
  });

  it('handles the top-level and wrapped course shapes', () => {
    const topLevel =
      '{"CourseId":"abc","InternalEventName":"QuickDraft_FRA_20260929","CurrentModule":"PlayerDraft"}';
    expect(parseDraftEvent(topLevel)).toEqual({
      kind: 'draft-start',
      eventName: 'QuickDraft_FRA_20260929',
      at: null,
    });

    const plural =
      '{"Courses":[{"InternalEventName":"Constructed_BestOf3","CurrentModule":"Complete"},{"InternalEventName":"PremierDraft_FRA_20260929","CurrentModule":"PlayerDraft"}]}';
    expect(parseDraftEvent(plural)).toEqual({
      kind: 'draft-start',
      eventName: 'PremierDraft_FRA_20260929',
      at: null,
    });
  });

  it('accepts the field-name variants other Arena builds use', () => {
    const event = parseDraftEvent(
      '[UnityCrossThreadLogger]Draft.Notify {"draftId":"d","SelfPick":3,"SelfPack":2,"PackCards":[1,2,3],"Extra":"ignored"}',
    );
    expect(event).toEqual({
      kind: 'pack',
      draftId: 'd',
      pack: 2,
      pick: 3,
      cards: [1, 2, 3],
      at: null,
    });
  });

  it('never throws on noise or malformed input', () => {
    const noise = [
      '',
      'x',
      'UnityEngine.DebugLogHandler:Internal_Log(LogType, LogOption, String, Object)',
      '[UnityCrossThreadLogger]Draft.Notify {not json',
      '[UnityCrossThreadLogger]==> EventPlayerDraftMakePick {"id":"a","request":"{oops"}',
      '[UnityCrossThreadLogger]==> EventSetDeckV3 {"id":"a"}',
      '[UnityCrossThreadLogger]Client.SceneChange {"fromSceneName":"Home","toSceneName":"Draft"}',
      '{ "InventoryInfo": { "Gems": 17580 } }',
      '{"Courses":[{"InternalEventName":"X","CurrentModule":null}]}',
    ];
    for (const line of noise) {
      expect(() => parseDraftEvent(line)).not.toThrow();
      expect(parseDraftEvent(line)).toBeNull();
    }
  });
});
