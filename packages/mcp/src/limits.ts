/**
 * Global, bounded, in-memory abuse controls for /mcp: a concurrency ceiling
 * and a fixed-window request budget. Both are process-wide counters (O(1)
 * memory). Nothing about the caller is stored: no IP, header, payload,
 * credential or client identifier.
 */

import { NeMcpConfigError } from "./errors.js";

export interface NeMcpLimits {
  /** Max /mcp requests in flight at once (1..64). */
  readonly maxConcurrent: number;
  /** Max /mcp requests accepted per 60 s window, all callers together (1..6000). */
  readonly maxRequestsPerMinute: number;
}

export const LOCAL_DEFAULT_LIMITS: NeMcpLimits = Object.freeze({ maxConcurrent: 16, maxRequestsPerMinute: 600 });
export const HOSTED_DEFAULT_LIMITS: NeMcpLimits = Object.freeze({ maxConcurrent: 8, maxRequestsPerMinute: 240 });
export const MAX_CONCURRENT_CEILING = 64;
export const MAX_REQUESTS_PER_MINUTE_CEILING = 6000;
const WINDOW_MS = 60_000;

export function resolveLimits(
  partial: { readonly maxConcurrent?: number | undefined; readonly maxRequestsPerMinute?: number | undefined } | undefined,
  defaults: NeMcpLimits,
): NeMcpLimits {
  const maxConcurrent = partial?.maxConcurrent ?? defaults.maxConcurrent;
  const maxRequestsPerMinute = partial?.maxRequestsPerMinute ?? defaults.maxRequestsPerMinute;
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > MAX_CONCURRENT_CEILING) {
    throw new NeMcpConfigError(`maxConcurrent (NE_MCP_MAX_CONCURRENT) must be an integer in 1..${MAX_CONCURRENT_CEILING}`);
  }
  if (!Number.isInteger(maxRequestsPerMinute) || maxRequestsPerMinute < 1 || maxRequestsPerMinute > MAX_REQUESTS_PER_MINUTE_CEILING) {
    throw new NeMcpConfigError(
      `maxRequestsPerMinute (NE_MCP_RATE_LIMIT_PER_MINUTE) must be an integer in 1..${MAX_REQUESTS_PER_MINUTE_CEILING}`,
    );
  }
  return Object.freeze({ maxConcurrent, maxRequestsPerMinute });
}

export type Admission = { readonly ok: true; readonly release: () => void } | { readonly ok: false; readonly retryAfterSeconds: number };

export class GlobalAbuseLimiter {
  private inFlight = 0;
  private windowStart = -Infinity;
  private windowCount = 0;

  constructor(
    readonly limits: NeMcpLimits,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** Admit one request or refuse it (caller answers 429 with Retry-After). */
  admit(): Admission {
    const now = this.now();
    if (now - this.windowStart >= WINDOW_MS) {
      this.windowStart = now;
      this.windowCount = 0;
    }
    if (this.windowCount >= this.limits.maxRequestsPerMinute) {
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((this.windowStart + WINDOW_MS - now) / 1000)) };
    }
    if (this.inFlight >= this.limits.maxConcurrent) return { ok: false, retryAfterSeconds: 1 };
    this.windowCount += 1;
    this.inFlight += 1;
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        this.inFlight -= 1;
      },
    };
  }

  get current(): { readonly inFlight: number; readonly windowCount: number } {
    return { inFlight: this.inFlight, windowCount: this.windowCount };
  }
}
