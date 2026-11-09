import { sanitizeLogText, type Redactor } from "./redaction.js";

export type LogStream = "stdout" | "stderr" | "manager";

export interface LogLine {
  /** Increases monotonically per model, across operations. */
  seq: number;
  at: string;
  stream: LogStream;
  text: string;
}

export interface LogPage {
  lines: LogLine[];
  /** Pass back as `after` to continue. */
  nextAfter: number;
  /** True when lines of this operation after `after` were already evicted. */
  truncated: boolean;
  hasMore: boolean;
}

const MAX_LINES = 2000;

/** The redacted, bounded output of one operation. */
export class OperationLog {
  readonly #lines: LogLine[] = [];
  readonly #firstSeq: number;
  #nextSeq: number;

  constructor(
    readonly operationId: string,
    firstSeq: number,
    readonly redactor: Redactor,
  ) {
    this.#firstSeq = firstSeq;
    this.#nextSeq = firstSeq;
  }

  get nextSeq(): number {
    return this.#nextSeq;
  }

  append(stream: LogStream, text: string): void {
    this.#lines.push({
      seq: this.#nextSeq,
      at: new Date().toISOString(),
      stream,
      text: sanitizeLogText(text, this.redactor),
    });
    this.#nextSeq += 1;
    if (this.#lines.length > MAX_LINES) {
      this.#lines.shift();
    }
  }

  tail(count: number): string[] {
    return this.#lines.slice(-count).map((line) => line.text);
  }

  read(after: number, limit: number): LogPage {
    // A cursor beyond anything issued comes from an earlier API run; start over.
    const from = after < this.#nextSeq ? after : 0;
    const start = this.#lines.findIndex((line) => line.seq > from);
    const available = start === -1 ? [] : this.#lines.slice(start);
    const lines = available.slice(0, limit).map((line) => ({ ...line }));
    const oldestSeq = this.#lines[0]?.seq ?? this.#nextSeq;
    return {
      lines,
      nextAfter: lines.at(-1)?.seq ?? from,
      truncated: oldestSeq > this.#firstSeq && from < oldestSeq - 1,
      hasMore: available.length > lines.length,
    };
  }
}
