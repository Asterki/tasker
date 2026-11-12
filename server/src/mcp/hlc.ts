/**
 * Hybrid logical clock used by the MCP peer.
 *
 * The format matches `src/sync/hlc.ts` so a task written by a model sorts and
 * merges exactly like a change from any device.
 */

export interface ParsedHlc {
  ms: number;
  counter: number;
  clientId: string;
}

const HLC_SIZE = 15;
const COUNTER_SIZE = 6;

export function formatHlc(ms: number, counter: number, clientId: string): string {
  return `${String(ms).padStart(HLC_SIZE, '0')}-${String(counter).padStart(COUNTER_SIZE, '0')}-${clientId}`;
}

export function parseHlc(value: string): ParsedHlc {
  const [msPart, counterPart, ...rest] = value.split('-');
  return {
    ms: Number(msPart),
    counter: Number(counterPart),
    clientId: rest.join('-'),
  };
}

export class HlcClock {
  private ms = 0;
  private counter = 0;

  constructor(
    private readonly clientId: string,
    last: string | null = null,
  ) {
    if (last) {
      const parsed = parseHlc(last);
      this.ms = parsed.ms;
      this.counter = parsed.counter;
    }
  }

  next(): string {
    const now = Date.now();
    if (now > this.ms) {
      this.ms = now;
      this.counter = 0;
    } else {
      this.counter += 1;
    }
    return formatHlc(this.ms, this.counter, this.clientId);
  }

  observe(remote: string): void {
    if (!remote) return;
    const parsed = parseHlc(remote);
    if (parsed.ms > this.ms) {
      this.ms = parsed.ms;
      this.counter = parsed.counter;
    } else if (parsed.ms === this.ms && parsed.counter > this.counter) {
      this.counter = parsed.counter;
    }
  }
}
