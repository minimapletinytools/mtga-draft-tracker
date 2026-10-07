/** Guard against unbounded growth if a "line" never terminates (corrupt log). */
const MAX_PARTIAL_LINE = 32 * 1024 * 1024;

/**
 * Assembles raw appended log text into complete lines. Arena's payloads are
 * single-line JSON, but a read can split a line across chunks — buffer the
 * partial tail until its newline arrives.
 */
export class LineAssembler {
  private partial = '';

  feed(chunk: string): string[] {
    if (!chunk) return [];

    const text = this.partial + chunk;
    const parts = text.split('\n');
    // The last element is whatever came after the final newline: keep buffering it.
    this.partial = parts.pop() ?? '';
    if (this.partial.length > MAX_PARTIAL_LINE) this.partial = '';

    // Player.log is written with \n on macOS and \r\n on Windows.
    for (let i = 0; i < parts.length; i++) {
      const line = parts[i] as string;
      if (line.charCodeAt(line.length - 1) === 13) parts[i] = line.slice(0, -1);
    }
    return parts;
  }

  /** Drops any buffered partial line — used when the log is truncated. */
  reset(): void {
    this.partial = '';
  }
}
