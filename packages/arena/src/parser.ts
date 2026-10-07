import type { DeckEntry } from '@drafttracker/core';
import type { DraftLogEvent } from './types.js';

/** Every Arena log payload we understand is prefixed with this. */
const CROSS_THREAD = '[UnityCrossThreadLogger]';

/**
 * `[UnityCrossThreadLogger]10/6/2026 5:58:06 PM` — Arena prints a bare
 * timestamp on its own line before the payload it belongs to. Tracking it
 * gives picks real wall-clock times (`seenAt`/`pickedAt`) instead of the
 * moment this app happened to parse them, which matters a lot when the whole
 * log is replayed on startup.
 */
const TIMESTAMP_RE =
  /^\[UnityCrossThreadLogger\](\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2}):(\d{2}) (AM|PM)$/;

/** Guard against pathological lines; real payloads are well under this. */
const MAX_PAYLOAD_LENGTH = 8 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
}

function asBool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/**
 * Parses Arena's two log line shapes that carry a timestamp:
 * `[UnityCrossThreadLogger]10/6/2026 5:58:06 PM` and the numbered variant
 * `[UnityCrossThreadLogger]10/6/2026 5:58:06 PM (1)`. Returns epoch ms in
 * local time, or null.
 */
export function parseLogTimestamp(line: string): number | null {
  const match = TIMESTAMP_RE.exec(line);
  if (!match) return null;

  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = Number(match[3]);
  const rawHour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const meridiem = match[7];

  if (month < 1 || month > 12 || day < 1 || day > 31 || rawHour > 12) return null;

  // 12 AM is midnight and 12 PM is noon; every other PM hour shifts by 12.
  const hour = (rawHour % 12) + (meridiem === 'PM' ? 12 : 0);
  const date = new Date(year, month - 1, day, hour, minute, second, 0);
  if (Number.isNaN(date.getTime())) return null;
  return date.getTime();
}

/** `"106394,106418"` → `[106394, 106418]`, skipping anything unparseable. */
export function parseGrpIdList(raw: string): number[] {
  const out: number[] = [];
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    const value = Number(trimmed);
    if (Number.isFinite(value)) out.push(Math.trunc(value));
  }
  return out;
}

/**
 * Arena wraps many requests as `{"id":"...","request":"<json string>"}`, so
 * the interesting payload is a JSON document embedded in a JSON string.
 * Returns the decoded inner object, or null.
 */
function decodeWrappedRequest(body: string, tag: string): Record<string, unknown> | null {
  const prefix = `==> ${tag} `;
  if (!body.startsWith(prefix)) return null;

  const jsonText = body.slice(prefix.length);
  if (jsonText.length === 0 || jsonText.length > MAX_PAYLOAD_LENGTH) return null;

  let wrapper: unknown;
  try {
    wrapper = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!isRecord(wrapper)) return null;

  const request = wrapper['request'];
  if (typeof request !== 'string') return null;

  try {
    const inner: unknown = JSON.parse(request);
    return isRecord(inner) ? inner : null;
  } catch {
    return null;
  }
}

function parsePackCards(value: unknown): number[] {
  if (typeof value === 'string') return parseGrpIdList(value);
  if (Array.isArray(value)) {
    const out: number[] = [];
    for (const item of value) {
      const id = asInt(item);
      if (id !== null) out.push(id);
    }
    return out;
  }
  return [];
}

function parseDeckEntries(value: unknown): DeckEntry[] {
  if (!Array.isArray(value)) return [];
  const out: DeckEntry[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    // Arena uses `cardId`; older payloads used `grpId`.
    const grpId = asInt(item['cardId']) ?? asInt(item['grpId']);
    if (grpId === null) continue;
    const quantity = asInt(item['quantity']) ?? 1;
    if (quantity <= 0) continue;
    out.push({ grpId, quantity });
  }
  return out;
}

/**
 * Course payloads come in three shapes, all of which appear in a single
 * session: `{"Course": {...}}`, `{"Courses": [{...}]}`, and a bare course
 * object at the top level.
 */
function extractCourses(parsed: Record<string, unknown>): Record<string, unknown>[] {
  const single = parsed['Course'];
  if (isRecord(single)) return [single];

  const many = parsed['Courses'];
  if (Array.isArray(many)) return many.filter(isRecord);

  if (typeof parsed['InternalEventName'] === 'string' && typeof parsed['CurrentModule'] === 'string') {
    return [parsed];
  }

  return [];
}

/**
 * Turns one raw Player.log line into a DraftLogEvent, or null when the line
 * is Unity noise (which is the overwhelming majority of them).
 *
 * This runs on every line of a log that can exceed 50 MB, so each branch
 * starts with a cheap substring reject before touching JSON.parse. It must
 * never throw: a malformed line is a line we don't care about.
 */
export function parseDraftEvent(line: string): DraftLogEvent | null {
  if (line.length < 16) return null;

  if (line.startsWith(CROSS_THREAD)) {
    const body = line.slice(CROSS_THREAD.length);

    // `Draft.Notify` is the pack you were just handed.
    if (body.startsWith('Draft.Notify ')) {
      const jsonText = body.slice('Draft.Notify '.length);
      if (jsonText.length > MAX_PAYLOAD_LENGTH) return null;

      let parsed: unknown;
      try {
        parsed = JSON.parse(jsonText);
      } catch {
        return null;
      }
      if (!isRecord(parsed)) return null;

      const draftId = asString(parsed['draftId']);
      // The log spells these both ways across Arena versions.
      const pack = asInt(parsed['SelfPack']) ?? asInt(parsed['Pack']);
      const pick = asInt(parsed['SelfPick']) ?? asInt(parsed['Pick']);
      if (draftId === null || pack === null || pick === null) return null;

      return {
        kind: 'pack',
        draftId,
        pack,
        pick,
        cards: parsePackCards(parsed['PackCards'] ?? parsed['Cards']),
        at: null,
      };
    }

    if (body.startsWith('==> EventPlayerDraftMakePick ')) {
      const inner = decodeWrappedRequest(body, 'EventPlayerDraftMakePick');
      if (inner === null) return null;

      const draftId = asString(inner['DraftId']) ?? asString(inner['draftId']);
      const pack = asInt(inner['Pack']);
      const pick = asInt(inner['Pick']);
      if (draftId === null || pack === null || pick === null) return null;

      const rawIds = inner['GrpIds'] ?? inner['grpIds'];
      const grpIds: number[] = [];
      if (Array.isArray(rawIds)) {
        for (const item of rawIds) {
          const id = asInt(item);
          if (id !== null) grpIds.push(id);
        }
      }

      return { kind: 'make-pick', draftId, pack, pick, grpIds, at: null };
    }

    if (body.startsWith('==> DraftCompleteDraft ')) {
      const inner = decodeWrappedRequest(body, 'DraftCompleteDraft');
      if (inner === null) return null;
      return {
        kind: 'draft-complete',
        eventName: asString(inner['EventName']),
        isBotDraft: asBool(inner['IsBotDraft']),
        at: null,
      };
    }

    if (body.startsWith('==> EventSetDeckV3 ')) {
      const inner = decodeWrappedRequest(body, 'EventSetDeckV3');
      if (inner === null) return null;

      const summary = isRecord(inner['Summary']) ? inner['Summary'] : {};
      const deck = isRecord(inner['Deck']) ? inner['Deck'] : {};

      return {
        kind: 'deck',
        eventName: asString(inner['EventName']),
        deckId: asString(summary['DeckId']),
        name: asString(summary['Name']),
        mainDeck: parseDeckEntries(deck['MainDeck']),
        sideboard: parseDeckEntries(deck['Sideboard']),
        at: null,
      };
    }

    return null;
  }

  // Course payloads are written as bare JSON lines with no prefix. They are
  // the only reliable "a draft is starting" signal: CurrentModule flips to
  // PlayerDraft, and later to DeckSelect once the picks are done.
  if (line.charCodeAt(0) !== 0x7b /* { */) return null;
  if (line.indexOf('"InternalEventName"') === -1) return null;
  if (line.length > MAX_PAYLOAD_LENGTH) return null;

  // Cheap shape check before the expensive parse: a course payload always
  // mentions a CurrentModule.
  if (line.indexOf('"CurrentModule"') === -1) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  // A Courses array can list several events, so scan for the one that is
  // actually in a draft module — PlayerDraft while picking, DeckSelect once
  // the picks are done.
  for (const course of extractCourses(parsed)) {
    const eventName = asString(course['InternalEventName']);
    const module = asString(course['CurrentModule']);

    if (module === 'PlayerDraft') {
      return { kind: 'draft-start', eventName, at: null };
    }
    if (module === 'DeckSelect' && eventName !== null && /draft/i.test(eventName)) {
      // DeckSelect for a draft means the picks are over. Reported as a
      // draft-complete so the tracker has two independent completion signals.
      return { kind: 'draft-complete', eventName, isBotDraft: null, at: null };
    }
  }

  return null;
}

/**
 * Attaches the most recent timestamp line to events that didn't carry one.
 * Arena prints the timestamp on the line before the payload, so the tracker
 * holds the last one it saw and stamps the next event with it.
 */
export function stampEvent(event: DraftLogEvent, at: number | null): DraftLogEvent {
  if (at === null) return event;
  return { ...event, at };
}
