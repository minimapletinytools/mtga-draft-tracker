import {
  DRAFT_PACKS,
  emptyDraft,
  inferSetCode,
  pickKey,
  setCodeFromEventName,
  sortPicks,
  type Draft,
  type DraftDeck,
  type DraftPick,
  type DraftStatus,
  type LiveState,
  type TrackerStatus,
} from '@drafttracker/core';
import { LineAssembler } from './lines.js';
import { parseDraftEvent, parseLogTimestamp, stampEvent } from './parser.js';
import { LogTailer } from './tailer.js';
import type { DraftLogEvent } from './types.js';

export interface DraftTrackerOptions {
  /** Absolute path to Arena's Player.log. */
  logPath: string;
  /** Log poll interval once caught up. Default 400ms. */
  pollIntervalMs?: number;
  /** Called whenever the live state changes (coalesced). */
  onLive: (state: LiveState) => void;
  /** Called once a draft stops being in progress, so the caller can persist it. */
  onDraftFinished?: (draft: Draft) => void;
  /** Called when a submitted deck is attached, including long after completion. */
  onDeckCaptured?: (draft: Draft) => void;
  /**
   * Resolves a card's set code. Injected so this package stays free of any
   * card-database dependency; used only to label a draft with its set.
   */
  setForCard?: (grpId: number) => string | null;
  /** Injectable clock, for tests. */
  now?: () => number;
  /** Injectable emit scheduler. Defaults to a microtask (coalesces replays). */
  emitScheduler?: (flush: () => void) => void;
}

/**
 * Turns a stream of Player.log lines into a live picture of the current draft.
 *
 * The whole log is replayed on startup, which is what makes recovery work: if
 * this app is launched halfway through a draft, every pick already made is
 * rebuilt before the live tail takes over. Every mutation is therefore written
 * to be idempotent — replaying the same line twice must not double-count it.
 */
export class DraftTracker {
  private readonly options: DraftTrackerOptions;
  private readonly now: () => number;
  private readonly schedule: (flush: () => void) => void;

  private readonly assembler = new LineAssembler();
  private tailer: LogTailer | null = null;

  private draft: Draft | null = null;
  /** Keyed by `${pack}:${pick}` so a replay merges instead of duplicating. */
  private picks = new Map<string, DraftPick>();

  /** Set by a Course payload in the PlayerDraft module, just before pack 1. */
  private pendingEventName: string | null = null;
  /** Arena prints a timestamp line before the payload it belongs to. */
  private lastTimestamp: number | null = null;

  private status: TrackerStatus = 'waiting';
  private message: string | null = null;

  /** Set once we've derived a set code from the cards themselves. */
  private setDerivedForDraftId: string | null = null;

  /** A draft seeded from disk, pending confirmation that it is still live. */
  private restoredDraftId: string | null = null;
  /** Whether the startup replay turned up any pack or pick at all. */
  private sawPickEvent = false;

  private emitPending = false;
  private emitScheduled = false;

  constructor(options: DraftTrackerOptions) {
    this.options = options;
    this.now = options.now ?? (() => Date.now());
    this.schedule = options.emitScheduler ?? ((flush) => queueMicrotask(flush));
    this.message = `Watching ${options.logPath}`;
  }

  start(): void {
    if (this.tailer !== null) return;
    this.tailer = new LogTailer(
      this.options.logPath,
      {
        onChunk: (text) => this.ingestText(text),
        onTruncate: () => this.handleTruncate(),
        onError: (err) => this.handleLogError(err),
      },
      this.options.pollIntervalMs,
    );
    this.tailer.start();

    // start() drains the existing log synchronously, so by this point we know
    // whether a restored draft still has any trace in the log.
    this.finalizeRestoredIfStale();
  }

  stop(): void {
    this.tailer?.stop();
    this.tailer = null;
  }

  /**
   * Seeds the tracker with a draft recovered from disk, so a draft survives
   * an app restart *and* an Arena restart that truncated the log.
   *
   * Call this before `start()`: the startup replay merges into the restored
   * draft by (pack, pick) instead of replacing it.
   */
  restore(draft: Draft): void {
    this.draft = cloneDraft(draft);
    this.picks.clear();
    for (const pick of this.draft.picks) {
      this.picks.set(pickKey(pick.pack, pick.pick), pick);
    }
    this.status = this.draft.status === 'in-progress' ? 'drafting' : 'complete';
    this.restoredDraftId = draft.status === 'in-progress' ? draft.draftId : null;
    this.scheduleEmit();
  }

  /**
   * A draft restored from disk is only still live if the log replay found
   * picks for it. If Arena has since been restarted, its log was truncated and
   * the draft is over — say so, rather than leaving a zombie draft that claims
   * to be in progress forever.
   */
  private finalizeRestoredIfStale(): void {
    const restoredId = this.restoredDraftId;
    this.restoredDraftId = null;
    if (restoredId === null || this.sawPickEvent) return;

    if (this.draft === null || this.draft.draftId !== restoredId) return;
    if (this.draft.status !== 'in-progress') return;

    this.finish('abandoned');
  }

  /** The current draft, as a deep copy safe to hand across IPC. */
  snapshot(): Draft | null {
    return this.draft === null ? null : cloneDraft(this.draft);
  }

  liveState(): LiveState {
    return {
      status: this.status,
      draft: this.snapshot(),
      pickCount: this.picks.size,
      message: this.message,
    };
  }

  /** Feeds raw log text (possibly many lines, possibly a partial line). */
  ingestText(text: string): void {
    for (const line of this.assembler.feed(text)) {
      this.ingestLine(line);
    }
  }

  /**
   * Handles a single complete log line. Public so tests can drive the tracker
   * from a fixture without touching the filesystem.
   */
  ingestLine(line: string): void {
    const timestamp = parseLogTimestamp(line);
    if (timestamp !== null) {
      this.lastTimestamp = timestamp;
      return;
    }

    let event: DraftLogEvent | null;
    try {
      event = parseDraftEvent(line);
    } catch {
      // parseDraftEvent is written not to throw; if a future Arena build
      // finds a way, one bad line must not stop the tail.
      return;
    }
    if (event === null) return;

    this.apply(stampEvent(event, this.lastTimestamp));
  }

  /** Forces a pending (coalesced) emit to happen now. */
  flush(): void {
    if (!this.emitPending) return;
    this.emitPending = false;
    this.options.onLive(this.liveState());
  }

  // ---------------------------------------------------------------- handlers

  private apply(event: DraftLogEvent): void {
    switch (event.kind) {
      case 'draft-start':
        this.pendingEventName = event.eventName;
        break;
      case 'pack':
        this.onPack(event);
        break;
      case 'make-pick':
        this.onMakePick(event);
        break;
      case 'draft-complete':
        this.onDraftComplete(event);
        break;
      case 'deck':
        this.onDeck(event);
        break;
    }
  }

  private onPack(event: Extract<DraftLogEvent, { kind: 'pack' }>): void {
    this.sawPickEvent = true;
    this.ensureDraft(event.draftId, event.at);

    const pick = this.upsertPick(event.pack, event.pick);
    pick.cardsSeen = [...event.cards];
    pick.seenAt = event.at ?? this.now();

    // The first pack is the best evidence of which set this is, and it beats
    // parsing the event name (which is absent if we joined mid-draft). Retried
    // on every pack until it succeeds, because the card database can still be
    // downloading when a draft starts.
    this.deriveSetCode(event.cards);

    this.status = 'drafting';
    this.touch();
    this.scheduleEmit();
  }

  private onMakePick(event: Extract<DraftLogEvent, { kind: 'make-pick' }>): void {
    this.sawPickEvent = true;
    this.ensureDraft(event.draftId, event.at);

    const pick = this.upsertPick(event.pack, event.pick);
    // Arena sends exactly one grpId per pick; take the first defensively.
    pick.picked = event.grpIds[0] ?? null;
    pick.pickedAt = event.at ?? this.now();

    this.status = 'drafting';
    this.touch();
    this.maybeAutoComplete();
    this.scheduleEmit();
  }

  private onDraftComplete(event: Extract<DraftLogEvent, { kind: 'draft-complete' }>): void {
    if (this.draft === null) return;
    if (!this.eventMatches(event.eventName)) return;

    if (this.draft.eventName === null && event.eventName !== null) {
      this.draft.eventName = event.eventName;
      this.draft.setCode ??= setCodeFromEventName(event.eventName);
    }
    if (event.isBotDraft !== null) this.draft.isBotDraft = event.isBotDraft;

    if (this.draft.status === 'in-progress') this.finish('complete');
  }

  private onDeck(event: Extract<DraftLogEvent, { kind: 'deck' }>): void {
    if (this.draft === null) return;
    if (event.mainDeck.length === 0 && event.sideboard.length === 0) return;
    if (!this.deckMatches(event.eventName)) return;

    if (this.draft.eventName === null && event.eventName !== null) {
      this.draft.eventName = event.eventName;
      this.draft.setCode ??= setCodeFromEventName(event.eventName);
    }

    const deck: DraftDeck = {
      deckId: event.deckId,
      name: event.name,
      mainDeck: event.mainDeck.map((e) => ({ ...e })),
      sideboard: event.sideboard.map((e) => ({ ...e })),
      capturedAt: event.at ?? this.now(),
    };
    this.draft.deck = deck;

    // Submitting a deck means the picks are over even if we never saw the
    // explicit completion line.
    if (this.draft.status === 'in-progress') {
      this.finish('complete');
    } else {
      this.touch();
      this.scheduleEmit();
    }

    const snapshot = cloneDraft(this.draft);
    this.options.onDeckCaptured?.(snapshot);
  }

  private handleTruncate(): void {
    this.assembler.reset();
    this.lastTimestamp = null;
    this.pendingEventName = null;

    // A truncated log means a new Arena session. A draft we were still
    // tracking cannot be resumed — Arena never rewrites one in progress — so
    // close it out rather than leaving a zombie that claims to be live.
    if (this.draft !== null && this.draft.status === 'in-progress') {
      this.finish('abandoned');
    }
  }

  private handleLogError(err: Error): void {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      this.status = 'no-log';
      this.message = `Arena log not found at ${this.options.logPath}. Start MTG Arena and it will be picked up automatically.`;
    } else {
      this.status = 'parse-error';
      this.message = `Could not read the Arena log: ${err.message}`;
    }
    this.scheduleEmit();
  }

  // ----------------------------------------------------------------- helpers

  /**
   * Creates the draft if we don't have this one yet. A different draftId while
   * one is in progress means the previous draft was abandoned — Arena issues a
   * fresh id per draft — so that one is closed out first.
   */
  private ensureDraft(draftId: string, at: number | null): void {
    if (this.draft !== null && this.draft.draftId === draftId) return;

    if (this.draft !== null && this.draft.status === 'in-progress') {
      this.finish('abandoned');
    }

    const draft = emptyDraft(draftId, at ?? this.now());
    draft.eventName = this.pendingEventName;
    draft.setCode = setCodeFromEventName(this.pendingEventName);
    this.draft = draft;
    this.picks.clear();
    this.setDerivedForDraftId = null;
    this.status = 'drafting';
    this.message = null;
  }

  private upsertPick(pack: number, pick: number): DraftPick {
    const key = pickKey(pack, pick);
    const existing = this.picks.get(key);
    if (existing !== undefined) return existing;

    const created: DraftPick = {
      pack,
      pick,
      cardsSeen: [],
      picked: null,
      seenAt: null,
      pickedAt: null,
    };
    this.picks.set(key, created);
    return created;
  }

  /** Never called once it has produced a set code for the current draft. */
  private deriveSetCode(cards: number[]): void {
    const lookup = this.options.setForCard;
    if (lookup === undefined || this.draft === null) return;
    if (this.setDerivedForDraftId === this.draft.draftId) return;
    if (cards.length === 0) return;

    const set = inferSetCode(cards, lookup);
    if (set !== null) {
      this.draft.setCode = set;
      this.setDerivedForDraftId = this.draft.draftId;
    }
  }

  /**
   * A one-card pack in the final pack means the draft is over. This is the
   * safety net for formats where Arena doesn't emit DraftCompleteDraft.
   */
  private maybeAutoComplete(): void {
    if (this.draft === null || this.draft.status !== 'in-progress') return;

    const picks = this.allPicks();
    const last = picks[picks.length - 1];
    if (last === undefined || last.pack < DRAFT_PACKS) return;
    if (last.cardsSeen.length === 1 && last.picked !== null) {
      this.finish('complete');
    }
  }

  private allPicks(): DraftPick[] {
    return sortPicks([...this.picks.values()]);
  }

  /** True when an event's event name can belong to the draft we're tracking. */
  private eventMatches(eventName: string | null): boolean {
    if (this.draft === null) return false;
    if (this.draft.eventName === null || eventName === null) return true;
    return this.draft.eventName === eventName;
  }

  /**
   * Stricter than eventMatches: attaching the wrong constructed deck to a
   * draft would be worse than attaching none, so an unknown draft event name
   * has to at least look like a draft.
   */
  private deckMatches(eventName: string | null): boolean {
    if (this.draft === null) return false;
    if (this.draft.eventName !== null && eventName !== null) {
      return this.draft.eventName === eventName;
    }
    if (eventName === null) return false;
    return this.draft.eventName === null && /draft/i.test(eventName);
  }

  private finish(status: DraftStatus): void {
    if (this.draft === null) return;
    this.draft.status = status;
    this.touch();
    // An abandoned draft isn't something to show as the live draft — the app
    // goes back to waiting, and the draft is available in history.
    this.status = status === 'complete' ? 'complete' : status === 'abandoned' ? 'waiting' : 'drafting';
    this.scheduleEmit();
    this.options.onDraftFinished?.(cloneDraft(this.draft));
  }

  private touch(): void {
    if (this.draft !== null) {
      this.draft.updatedAt = this.now();
      this.draft.picks = this.allPicks();
    }
  }

  private scheduleEmit(): void {
    this.emitPending = true;
    if (this.emitScheduled) return;
    this.emitScheduled = true;
    this.schedule(() => {
      this.emitScheduled = false;
      this.flush();
    });
  }
}

/** Deep copy, so a snapshot handed to another process can never alias state. */
export function cloneDraft(draft: Draft): Draft {
  return {
    ...draft,
    picks: draft.picks.map((pick) => ({
      ...pick,
      cardsSeen: [...pick.cardsSeen],
    })),
    deck:
      draft.deck === null
        ? null
        : {
            ...draft.deck,
            mainDeck: draft.deck.mainDeck.map((e) => ({ ...e })),
            sideboard: draft.deck.sideboard.map((e) => ({ ...e })),
          },
  };
}
