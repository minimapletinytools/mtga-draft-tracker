import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { summarizeDraft, type Draft, type DraftSummary } from '@drafttracker/core';

/** Written here while a draft is still being picked, so a crash can't lose it. */
const IN_PROGRESS_FILE = 'in-progress.json';

/** Files that live in the drafts directory but aren't drafts. */
const NON_DRAFT_FILES = new Set([IN_PROGRESS_FILE]);

/** Makes every temp file name unique within a process. */
let writeCounter = 0;

function isDraftFile(name: string): boolean {
  return name.endsWith('.json') && !NON_DRAFT_FILES.has(name);
}

/**
 * Drafts on disk: one JSON file per draft, plus a single in-progress file.
 *
 * One file per draft rather than an index keeps writes small and atomic, makes
 * a corrupt draft cost exactly one draft, and means the saved data is
 * human-readable if you ever want to poke at it.
 */
export class DraftStore {
  readonly dir: string;

  /**
   * Serializes writes. A draft finishing fires several saves at once (the
   * draft itself, then the deck a few minutes later, then the in-progress file
   * being cleared), and two concurrent temp-file + rename cycles on the same
   * path race each other into ENOENT.
   */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dir: string) {
    this.dir = dir;
  }

  filePath(draftId: string): string {
    // Draft ids are Arena UUIDs; sanitize anyway so a hostile id can't escape.
    const safe = draftId.replace(/[^A-Za-z0-9._-]/g, '_');
    return path.join(this.dir, `${safe}.json`);
  }

  private get inProgressPath(): string {
    return path.join(this.dir, IN_PROGRESS_FILE);
  }

  /** Runs `task` after every previously queued write has settled. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    // Failures are the caller's problem; the queue must keep moving.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Writes via a temp file + rename, so a crash mid-write leaves the previous
   * version intact rather than a half-written draft.
   */
  private async writeJson(filePath: string, value: unknown): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    // A per-write temp name, so even an unsynchronized second writer can't
    // steal the first one's file between writeFile and rename.
    const temp = `${filePath}.${writeCounter++}.tmp`;
    await writeFile(temp, JSON.stringify(value, null, 2), 'utf8');
    try {
      await rename(temp, filePath);
    } catch (err) {
      await rm(temp, { force: true });
      throw err;
    }
  }

  private async readJson<T>(filePath: string): Promise<T | null> {
    let raw: string;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch {
      return null;
    }
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async save(draft: Draft): Promise<void> {
    return this.enqueue(() => this.writeJson(this.filePath(draft.draftId), draft));
  }

  async load(draftId: string): Promise<Draft | null> {
    const draft = await this.readJson<Draft>(this.filePath(draftId));
    return isDraftLike(draft) ? draft : null;
  }

  async remove(draftId: string): Promise<void> {
    return this.enqueue(() => rm(this.filePath(draftId), { force: true }));
  }

  /**
   * Every saved draft, newest first.
   *
   * Reads the whole directory rather than maintaining an index: a draft file
   * is a few KB, and there is no index to get out of sync with the files.
   */
  async list(): Promise<DraftSummary[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }

    const summaries: DraftSummary[] = [];
    for (const name of names) {
      if (!isDraftFile(name)) continue;
      const draft = await this.readJson<Draft>(path.join(this.dir, name));
      if (!isDraftLike(draft)) continue;
      summaries.push(summarizeDraft(draft));
    }

    summaries.sort((a, b) => b.startedAt - a.startedAt);
    return summaries;
  }

  // ------------------------------------------------------------- in progress

  async saveInProgress(draft: Draft): Promise<void> {
    return this.enqueue(() => this.writeJson(this.inProgressPath, draft));
  }

  async loadInProgress(): Promise<Draft | null> {
    const draft = await this.readJson<Draft>(this.inProgressPath);
    return isDraftLike(draft) ? draft : null;
  }

  async clearInProgress(): Promise<void> {
    return this.enqueue(() => rm(this.inProgressPath, { force: true }));
  }
}

/**
 * A shape check rather than a schema: a truncated or hand-edited file should
 * be skipped, not crash the history list.
 */
function isDraftLike(value: unknown): value is Draft {
  if (value === null || typeof value !== 'object') return false;
  const draft = value as Partial<Draft>;
  return (
    typeof draft.draftId === 'string' &&
    draft.draftId.length > 0 &&
    Array.isArray(draft.picks) &&
    typeof draft.startedAt === 'number'
  );
}
