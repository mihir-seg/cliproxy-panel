/**
 * Pooled quota across every account of one provider, one card per weekly window.
 *
 * Accounts are interchangeable behind the proxy, so the useful question is "how much is left in
 * the whole pool, and when does more come back?" — not each account in isolation. Each account
 * contributes its remaining percentage of the window that binds it (Claude: the Fable weekly
 * limit when reported, otherwise the overall weekly limit; Codex: the weekly limit), so a pool of
 * three fresh accounts reads 300% of 300%.
 *
 * React-free so tests/quotaPool.test.ts can drive it with plain fixtures.
 */

import type { QuotaFileEntry } from './logic';
import type { QuotaCardState } from './providers';
import type { QuotaProviderType } from './providers/types';

/** Providers whose windows we know how to pool; others keep their per-account cards only. */
export const POOLED_PROVIDERS: readonly QuotaProviderType[] = ['claude', 'codex'];

interface PoolWindowSpec {
  /** Each window any loaded account reports gets its own pool card, in this order. */
  windows: readonly string[];
  /** The rolling short window used for the "available right now" count. */
  session: string;
}

const POOL_WINDOWS: Partial<Record<QuotaProviderType, PoolWindowSpec>> = {
  // Fable binds first, but the overall weekly limit can still run out: both get a card.
  claude: { windows: ['seven-day-fable', 'seven-day'], session: 'five-hour' },
  codex: { windows: ['weekly'], session: 'five-hour' },
};

interface PoolableWindow {
  id: string;
  labelKey?: string;
  label?: string;
  usedPercent: number | null;
  resetAtMs?: number | null;
}

export interface PoolSegment {
  /** Cache key of the account, stable across refreshes. */
  key: string;
  name: string;
  /** Remaining percentage of the pool's window, 0–100. */
  remaining: number;
}

export interface PoolReset {
  atMs: number;
  /** Percentage points the pool regains at that instant. */
  regain: number;
}

export interface QuotaPool {
  /** Unique per card: provider and window. */
  key: string;
  type: QuotaProviderType;
  /** Accounts of this provider that are enabled, loaded or not. */
  accountCount: number;
  /** Accounts that reported this pool's window. */
  loadedCount: number;
  windowId: string;
  labelKey?: string;
  label?: string;
  /** Sum of remaining percentages across loaded accounts. */
  remaining: number;
  /** loadedCount × 100. */
  capacity: number;
  segments: PoolSegment[];
  nextReset: PoolReset | null;
  /** Loaded accounts whose short window still has room (below 100% used). */
  sessionAvailable: number;
  sessionReported: number;
}

const clampPercent = (value: number) => Math.min(100, Math.max(0, value));

const windowsOf = (quota: QuotaCardState | undefined): PoolableWindow[] => {
  if (!quota || quota.status !== 'success') return [];
  const windows = (quota as { windows?: unknown }).windows;
  return Array.isArray(windows) ? (windows as PoolableWindow[]) : [];
};

const findWindow = (windows: PoolableWindow[], id: string) =>
  windows.find((window) => window.id === id && typeof window.usedPercent === 'number');

/**
 * Build one pool card per reported window of each pooled provider with enabled accounts.
 * Before any account has loaded, a provider shows a single waiting card for its last window.
 * `now` is injected so resets in the past are ignored deterministically.
 */
export function buildQuotaPools(
  entries: QuotaFileEntry[],
  quotaFor: (entry: QuotaFileEntry) => QuotaCardState | undefined,
  keyFor: (entry: QuotaFileEntry) => string,
  nameFor: (entry: QuotaFileEntry) => string,
  now: number
): QuotaPool[] {
  const pools: QuotaPool[] = [];

  for (const type of POOLED_PROVIDERS) {
    const spec = POOL_WINDOWS[type];
    const accounts = entries.filter((entry) => entry.type === type && !entry.file.disabled);
    if (!spec || accounts.length === 0) continue;

    const loaded = accounts.map((entry) => ({ entry, windows: windowsOf(quotaFor(entry)) }));
    const reported = spec.windows.filter((id) =>
      loaded.some(({ windows }) => findWindow(windows, id))
    );
    const windowIds = reported.length > 0 ? reported : [spec.windows[spec.windows.length - 1]];

    let sessionAvailable = 0;
    let sessionReported = 0;
    for (const { windows } of loaded) {
      const session = findWindow(windows, spec.session);
      if (session) {
        sessionReported += 1;
        if ((session.usedPercent as number) < 100) sessionAvailable += 1;
      }
    }

    for (const windowId of windowIds) {
      const segments: PoolSegment[] = [];
      let labelSource: PoolableWindow | undefined;
      let nextReset: PoolReset | null = null;

      for (const { entry, windows } of loaded) {
        const window = findWindow(windows, windowId);
        if (!window) continue;
        labelSource ??= window;
        const used = clampPercent(window.usedPercent as number);
        segments.push({ key: keyFor(entry), name: nameFor(entry), remaining: 100 - used });
        const at = window.resetAtMs;
        if (typeof at === 'number' && at > now && used > 0) {
          if (!nextReset || at < nextReset.atMs) nextReset = { atMs: at, regain: used };
          else if (at === nextReset.atMs) nextReset = { atMs: at, regain: nextReset.regain + used };
        }
      }

      pools.push({
        key: `${type}:${windowId}`,
        type,
        accountCount: accounts.length,
        loadedCount: segments.length,
        windowId,
        labelKey: labelSource?.labelKey,
        label: labelSource?.label,
        remaining: segments.reduce((sum, segment) => sum + segment.remaining, 0),
        capacity: segments.length * 100,
        segments,
        nextReset,
        sessionAvailable,
        sessionReported,
      });
    }
  }

  return pools;
}

// The local part stops at '-' because credential names join a prefix to the email with one
// (`claude-<id>-<email>.json`); an address with its own hyphen still loses everything after it.
const EMAIL_PATTERN =
  /([A-Za-z0-9._%+])[A-Za-z0-9._%+]*@([A-Za-z0-9-])[A-Za-z0-9.-]*?(\.[A-Za-z]{2,})(?=$|[^A-Za-z0-9.-]|\.json)/g;

/**
 * Hide the email inside a credential name for screenshots and screen sharing:
 * `claude-7a412b6b-mihir@segwise.ai.json` → `claude-7a412b6b-m•••@s•••.ai.json`.
 * Keeps the first character of each part and the top-level domain so accounts stay tellable apart.
 */
export function maskEmails(value: string): string {
  return value.replace(EMAIL_PATTERN, '$1•••@$2•••$3');
}
