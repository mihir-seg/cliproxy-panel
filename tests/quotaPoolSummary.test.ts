import { describe, expect, test } from 'bun:test';
import { buildQuotaPools, maskEmails } from '@/features/quota/pool';
import type { QuotaFileEntry } from '@/features/quota/logic';
import type { QuotaCardState } from '@/features/quota/providers';
import type { AuthFileItem } from '@/types';

const NOW = Date.UTC(2026, 10, 20, 6, 0);
const HOUR = 3_600_000;

const entry = (name: string, type: 'claude' | 'codex', extra: Partial<AuthFileItem> = {}) =>
  ({ file: { name, provider: type, ...extra } as AuthFileItem, type }) as QuotaFileEntry;

type Win = { id: string; usedPercent: number | null; resetAtMs?: number | null; labelKey?: string };
const ok = (windows: Win[]) => ({ status: 'success', windows }) as unknown as QuotaCardState;

const pools = (entries: QuotaFileEntry[], quota: Record<string, QuotaCardState | undefined>) =>
  buildQuotaPools(
    entries,
    (e) => quota[e.file.name],
    (e) => e.file.name,
    (e) => e.file.name,
    NOW
  );

describe('buildQuotaPools', () => {
  const a = entry('claude-a.json', 'claude');
  const b = entry('claude-b.json', 'claude');
  const c = entry('claude-c.json', 'claude');

  test('sums remaining weekly quota across accounts', () => {
    const [pool] = pools([a, b, c], {
      'claude-a.json': ok([{ id: 'seven-day', usedPercent: 53, resetAtMs: NOW + 8 * HOUR }]),
      'claude-b.json': ok([{ id: 'seven-day', usedPercent: 100, resetAtMs: NOW + 11 * HOUR }]),
      'claude-c.json': ok([{ id: 'seven-day', usedPercent: 46, resetAtMs: NOW + 127 * HOUR }]),
    });
    expect(pool.type).toBe('claude');
    expect(pool.remaining).toBe(47 + 0 + 54);
    expect(pool.capacity).toBe(300);
    expect(pool.segments.map((s) => s.remaining)).toEqual([47, 0, 54]);
    // The soonest reset wins, and it gives back what that account had used.
    expect(pool.nextReset).toEqual({ atMs: NOW + 8 * HOUR, regain: 53 });
  });

  test('gives the Fable weekly limit and the overall weekly limit separate cards', () => {
    const result = pools([a, b], {
      'claude-a.json': ok([
        { id: 'seven-day', usedPercent: 20, resetAtMs: NOW + HOUR },
        { id: 'seven-day-fable', usedPercent: 40, resetAtMs: NOW + 2 * HOUR },
      ]),
      'claude-b.json': ok([{ id: 'seven-day', usedPercent: 10, resetAtMs: NOW + HOUR }]),
    });
    expect(result.map((pool) => pool.key)).toEqual(['claude:seven-day-fable', 'claude:seven-day']);
    const [fable, weekly] = result;
    expect(fable.capacity).toBe(100); // only one account reports Fable
    expect(fable.remaining).toBe(60);
    expect(fable.nextReset).toEqual({ atMs: NOW + 2 * HOUR, regain: 40 });
    expect(weekly.capacity).toBe(200);
    expect(weekly.remaining).toBe(80 + 90);
    expect(weekly.nextReset).toEqual({ atMs: NOW + HOUR, regain: 30 });
  });

  test('shows one waiting card before any account has loaded', () => {
    const result = pools([a, b], {});
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ windowId: 'seven-day', loadedCount: 0, capacity: 0 });
  });

  test('counts accounts with 5-hour room and ignores past resets', () => {
    const [pool] = pools([a, b], {
      'claude-a.json': ok([
        { id: 'seven-day', usedPercent: 30, resetAtMs: NOW - HOUR },
        { id: 'five-hour', usedPercent: 100 },
      ]),
      'claude-b.json': ok([
        { id: 'seven-day', usedPercent: 0, resetAtMs: NOW + HOUR },
        { id: 'five-hour', usedPercent: 12 },
      ]),
    });
    expect(pool.sessionAvailable).toBe(1);
    expect(pool.sessionReported).toBe(2);
    // a: reset already passed; b: nothing used, so nothing to regain.
    expect(pool.nextReset).toBeNull();
  });

  test('adds up accounts that reset at the same instant', () => {
    const at = NOW + 5 * HOUR;
    const [pool] = pools([a, b], {
      'claude-a.json': ok([{ id: 'seven-day', usedPercent: 30, resetAtMs: at }]),
      'claude-b.json': ok([{ id: 'seven-day', usedPercent: 25, resetAtMs: at }]),
    });
    expect(pool.nextReset).toEqual({ atMs: at, regain: 55 });
  });

  test('keeps a pool for providers that are not loaded yet and skips disabled accounts', () => {
    const off = entry('claude-off.json', 'claude', { disabled: true });
    const [pool] = pools([a, off], { 'claude-a.json': { status: 'loading' } as QuotaCardState });
    expect(pool.accountCount).toBe(1);
    expect(pool.loadedCount).toBe(0);
    expect(pool.capacity).toBe(0);
  });

  test('builds no pool for providers without accounts', () => {
    expect(pools([], {})).toEqual([]);
  });

  test('pools Codex on its weekly window', () => {
    const x = entry('codex-x.json', 'codex');
    const [pool] = pools([x], {
      'codex-x.json': ok([
        { id: 'five-hour', usedPercent: 50 },
        { id: 'weekly', usedPercent: 17, resetAtMs: NOW + 48 * HOUR },
      ]),
    });
    expect(pool.type).toBe('codex');
    expect(pool.remaining).toBe(83);
    expect(pool.key).toBe('codex:weekly');
  });
});

describe('maskEmails', () => {
  test('hides the email in a credential file name', () => {
    expect(maskEmails('claude-7a412b6b-mihir@segwise.ai.json')).toBe(
      'claude-7a412b6b-m•••@s•••.ai.json'
    );
    expect(maskEmails('claude-7a412b6b-playable_ads@segwise.ai.json')).toBe(
      'claude-7a412b6b-p•••@s•••.ai.json'
    );
  });

  test('keeps the top-level domain and leaves names without an email alone', () => {
    expect(maskEmails('someone@example.co.uk')).toBe('s•••@e•••.uk');
    expect(maskEmails('codex-a.json')).toBe('codex-a.json');
  });

  test('never leaves the full address visible', () => {
    const masked = maskEmails('codex-team@gmail.com-pro.json');
    expect(masked).not.toContain('team@');
    expect(masked).not.toContain('gmail');
  });
});
