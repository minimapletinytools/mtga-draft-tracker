import * as fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import type { TailerCallbacks } from './types.js';

/** Cap bytes consumed per poll so a huge backlog is streamed, not slurped. */
const MAX_READ_PER_POLL = 4 * 1024 * 1024;

/**
 * How much of an existing log to replay eagerly on start(). Arena logs run to
 * tens of megabytes; reading them all in one blocking burst would stall the
 * first paint, but waiting for the poll loop would trickle a mid-draft
 * recovery in over many seconds. 192 MB is far past any real log while still
 * bounding the work.
 */
const STARTUP_DRAIN_BUDGET = 192 * 1024 * 1024;

/**
 * Poll-based follower of Player.log: remembers the byte position, emits
 * appended text, and detects truncation or replacement (Arena rewrites the
 * file on launch) to restart from zero.
 *
 * Poll-based rather than fs.watch: Arena appends constantly, and on macOS
 * fs.watch on a file being rewritten by a game produces a storm of events for
 * a single logical append.
 */
export class LogTailer {
  private readonly path: string;
  private readonly callbacks: TailerCallbacks;
  private readonly pollIntervalMs: number;

  private timer: ReturnType<typeof setInterval> | null = null;
  private position = 0;
  /** UTF-8 sequences can straddle a read boundary; the decoder holds the tail. */
  private decoder = new StringDecoder('utf8');
  /** Deduped error signature, cleared as soon as a poll succeeds. */
  private lastErrorKey: string | null = null;
  private inode: number | null = null;
  private started = false;

  constructor(path: string, callbacks: TailerCallbacks, pollIntervalMs = 400) {
    this.path = path;
    this.callbacks = callbacks;
    this.pollIntervalMs = pollIntervalMs > 0 ? pollIntervalMs : 400;
  }

  /** Byte offset of the next unread byte — the live edge of the log. */
  get offset(): number {
    return this.position;
  }

  start(): void {
    if (this.started) return;
    this.started = true;

    // Catch up on everything already written before switching to polling, so
    // a draft that started before this app did is rebuilt immediately.
    let drained = 0;
    while (drained < STARTUP_DRAIN_BUDGET) {
      const read = this.poll();
      if (read <= 0) break;
      drained += read;
    }

    this.timer = setInterval(() => this.poll(), this.pollIntervalMs);
    // Don't keep a Node process alive just for the tail loop.
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.started = false;
  }

  /** @returns bytes consumed, 0 when caught up or unreadable. */
  private poll(): number {
    let stats: fs.Stats;
    try {
      stats = fs.statSync(this.path);
    } catch (err) {
      this.rewind();
      this.emitError(err);
      return 0;
    }

    try {
      if (!stats.isFile()) {
        this.rewind();
        this.emitError(new Error(`Not a file: ${this.path}`));
        return 0;
      }

      // The log was replaced (new inode) or truncated — restart from byte 0.
      const replaced =
        this.inode !== null && stats.ino !== 0 && this.inode !== 0 && stats.ino !== this.inode;
      if (replaced || stats.size < this.position) {
        this.rewind();
        this.safe(() => this.callbacks.onTruncate());
      }
      this.inode = stats.ino;
      this.lastErrorKey = null;

      if (stats.size <= this.position) return 0;

      const length = Math.min(stats.size - this.position, MAX_READ_PER_POLL);
      const buffer = Buffer.allocUnsafe(length);
      let bytesRead = 0;
      const fd = fs.openSync(this.path, 'r');
      try {
        bytesRead = fs.readSync(fd, buffer, 0, length, this.position);
      } finally {
        fs.closeSync(fd);
      }
      if (bytesRead <= 0) return 0;

      this.position += bytesRead;
      const text = this.decoder.write(buffer.subarray(0, bytesRead));
      if (text.length > 0) this.safe(() => this.callbacks.onChunk(text));
      return bytesRead;
    } catch (err) {
      this.emitError(err);
      return 0;
    }
  }

  private rewind(): void {
    this.position = 0;
    this.inode = null;
    this.decoder = new StringDecoder('utf8');
  }

  private emitError(err: unknown): void {
    const error = err instanceof Error ? err : new Error(String(err));
    const key = `${(error as NodeJS.ErrnoException).code ?? ''}:${error.message}`;
    // A missing log stays missing for every poll — report it once.
    if (key === this.lastErrorKey) return;
    this.lastErrorKey = key;
    this.safe(() => this.callbacks.onError(error));
  }

  /** A throwing consumer must never kill the poll loop. */
  private safe(fn: () => void): void {
    try {
      fn();
    } catch {
      /* ignore */
    }
  }
}
