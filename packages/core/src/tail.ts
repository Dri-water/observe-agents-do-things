/**
 * Incremental JSONL tailer.
 *
 * - Splits on raw bytes (0x0A never occurs inside a multi-byte UTF-8 sequence),
 *   so characters straddling a read boundary are never corrupted.
 * - Carries partial trailing lines over to the next read.
 * - Handles truncation/rotation by starting over.
 * - For very large files, reads a small head (session metadata lives there)
 *   plus a bounded tail instead of the whole thing.
 */
import { open, stat } from 'node:fs/promises'

const NEWLINE = 0x0a
const CHUNK = 4 * 1024 * 1024
/** A single runaway line longer than this is dropped rather than buffered forever. */
const MAX_LINE = 64 * 1024 * 1024

export interface TailInit {
  lines: string[]
  /** True when only part of the file was read. */
  partial: boolean
}

export class FileTail {
  offset = 0
  size = 0
  private rest: Buffer[] = []
  private restLen = 0
  private skipToNewline = false

  constructor(readonly path: string) {}

  /**
   * Position the tail and return the lines to backfill.
   * Files up to `backfillBytes` are read whole. Larger files yield their first
   * `headBytes` (complete lines only) followed by the last `backfillBytes`.
   */
  async init(backfillBytes: number, headBytes = 512 * 1024): Promise<TailInit> {
    const st = await stat(this.path)
    if (st.size <= backfillBytes + headBytes) {
      this.offset = 0
      return { lines: await this.read(), partial: false }
    }
    const head = await this.readRange(0, Math.min(headBytes, st.size))
    const lastNl = head.lastIndexOf(NEWLINE)
    const headLines = lastNl > 0 ? splitLines(head.subarray(0, lastNl)) : []
    this.offset = st.size - backfillBytes
    this.skipToNewline = true
    const tailLines = await this.read()
    return { lines: [...headLines, ...tailLines], partial: true }
  }

  /** Read and return any complete lines appended since the last call. */
  async read(): Promise<string[]> {
    let st
    try {
      st = await stat(this.path)
    } catch {
      return []
    }
    if (st.size < this.offset) {
      // Truncated or replaced: start over.
      this.offset = 0
      this.rest = []
      this.restLen = 0
      this.skipToNewline = false
    }
    this.size = st.size
    if (st.size === this.offset) return []

    const lines: string[] = []
    const fh = await open(this.path, 'r')
    try {
      while (this.offset < st.size) {
        const len = Math.min(CHUNK, st.size - this.offset)
        const buf = Buffer.allocUnsafe(len)
        const { bytesRead } = await fh.read(buf, 0, len, this.offset)
        if (bytesRead <= 0) break
        this.offset += bytesRead
        this.consume(buf.subarray(0, bytesRead), lines)
      }
    } finally {
      await fh.close()
    }
    return lines
  }

  private consume(chunk: Buffer, out: string[]): void {
    let start = 0
    if (this.skipToNewline) {
      const nl = chunk.indexOf(NEWLINE)
      if (nl < 0) return
      start = nl + 1
      this.skipToNewline = false
    }
    let nl = chunk.indexOf(NEWLINE, start)
    while (nl >= 0) {
      const piece = chunk.subarray(start, nl)
      if (this.restLen > 0) {
        this.rest.push(piece)
        pushLine(Buffer.concat(this.rest), out)
        this.rest = []
        this.restLen = 0
      } else {
        pushLine(piece, out)
      }
      start = nl + 1
      nl = chunk.indexOf(NEWLINE, start)
    }
    if (start < chunk.length) {
      const remainder = chunk.subarray(start)
      this.restLen += remainder.length
      if (this.restLen > MAX_LINE) {
        this.rest = []
        this.restLen = 0
        this.skipToNewline = true
      } else {
        // Copy: the chunk buffer is reused by nobody, but subarray keeps the whole chunk alive.
        this.rest.push(Buffer.from(remainder))
      }
    }
  }

  private async readRange(start: number, length: number): Promise<Buffer> {
    const fh = await open(this.path, 'r')
    try {
      const buf = Buffer.allocUnsafe(length)
      const { bytesRead } = await fh.read(buf, 0, length, start)
      return buf.subarray(0, bytesRead)
    } finally {
      await fh.close()
    }
  }
}

function pushLine(buf: Buffer, out: string[]): void {
  let end = buf.length
  if (end > 0 && buf[end - 1] === 0x0d) end--
  if (end === 0) return
  out.push(buf.toString('utf8', 0, end))
}

function splitLines(buf: Buffer): string[] {
  const out: string[] = []
  let start = 0
  let nl = buf.indexOf(NEWLINE)
  while (nl >= 0) {
    pushLine(buf.subarray(start, nl), out)
    start = nl + 1
    nl = buf.indexOf(NEWLINE, start)
  }
  if (start < buf.length) pushLine(buf.subarray(start), out)
  return out
}
