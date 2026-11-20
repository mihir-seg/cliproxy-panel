/**
 * Pooled quota across every account of one provider.
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
  /** Window ids tried in order; the first one any loaded account reports becomes the pool basis. */
  primary: readonly string[];
  /** Overall weekly window shown under the primary when the primary is model-scoped. */
  secondary?: string;
  /** The rolling short window used for the "available right now" count. */
  session: string;
}

const POOL_WINDOWS: Partial<Record<QuotaProviderType, PoolWindowSpec>> = {
  claude: {
    primary: ['seven-day-fable', 'seven-day'],
    secondary: 'seven-day',
    session: 'five-hour',
  },
  codex: { primary: ['weekly'], session: 'five-hour' },
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
  /** Remaining percentage of the pool's primary window, 0–100. */
  remaining: number;
}

export interface PoolReset {
  atMs: number;
  /** Percentage points the pool regains at that instant. */
  regain: number;
}

export interface QuotaPool {
  type: QuotaProviderType;
  /** Accounts of this provider that are enabled, loaded or not. */
  accountCount: number;
  /** Accounts that reported the primary window. */
  loadedCount: number;
  primaryWindowId: string;
  primaryLabelKey?: string;
  primaryLabel?: string;
  /** Sum of remaining percentages across loaded accounts. */
  remaining: number;
  /** loadedCount × 100. */
  capacity: number;
  segments: PoolSegment[];
  nextReset: PoolReset | null;
  secondary: { labelKey?: string; label?: string; remaining: number; capacity: number } | null;
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
 * Build one pool per pooled provider that has at least one enabled account.
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
    const primaryId =
      spec.primary.find((id) => loaded.some(({ windows }) => findWindow(windows, id))) ??
      spec.primary[spec.primary.length - 1];

    const segments: PoolSegment[] = [];
    let labelSource: PoolableWindow | undefined;
    let nextReset: PoolReset | null = null;
    let secondaryRemaining = 0;
    let secondaryCount = 0;
    let secondarySource: PoolableWindow | undefined;
    let sessionAvailable = 0;
    let sessionReported = 0;

    for (const { entry, windows } of loaded) {
      const primary = findWindow(windows, primaryId);
      if (primary) {
        labelSource ??= primary;
        const used = clampPercent(primary.usedPercent as number);
        segments.push({ key: keyFor(entry), name: nameFor(entry), remaining: 100 - used });
        const at = primary.resetAtMs;
        if (typeof at === 'number' && at > now && used > 0) {
          if (!nextReset || at < nextReset.atMs) nextReset = { atMs: at, regain: used };
          else if (at === nextReset.atMs) nextReset = { atMs: at, regain: nextReset.regain + used };
        }
      }
      if (spec.secondary && spec.secondary !== primaryId) {
        const secondary = findWindow(windows, spec.secondary);
        if (secondary) {
          secondarySource ??= secondary;
          secondaryRemaining += 100 - clampPercent(secondary.usedPercent as number);
          secondaryCount += 1;
        }
      }
      const session = findWindow(windows, spec.session);
      if (session) {
        sessionReported += 1;
        if ((session.usedPercent as number) < 100) sessionAvailable += 1;
      }
    }

    pools.push({
      type,
      accountCount: accounts.length,
      loadedCount: segments.length,
      primaryWindowId: primaryId,
      primaryLabelKey: labelSource?.labelKey,
      primaryLabel: labelSource?.label,
      remaining: segments.reduce((sum, segment) => sum + segment.remaining, 0),
      capacity: segments.length * 100,
      segments,
      nextReset,
      secondary:
        secondaryCount > 0
          ? {
              labelKey: secondarySource?.labelKey,
              label: secondarySource?.label,
              remaining: secondaryRemaining,
              capacity: secondaryCount * 100,
            }
          : null,
      sessionAvailable,
      sessionReported,
    });
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
