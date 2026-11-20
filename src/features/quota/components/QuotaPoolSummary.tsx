/**
 * Pool summary: one card per provider with the remaining quota across every account,
 * a segment per account, and when the pool next gets quota back.
 */

import { useTranslation } from 'react-i18next';
import { getAuthFileIcon, getTypeLabel } from '@/features/authFiles/constants';
import { buildResetDisplay } from '@/utils/quota/relativeTime';
import type { ResolvedTheme } from '@/types';
import { QUOTA_PROGRESS_HIGH_THRESHOLD, QUOTA_PROGRESS_MEDIUM_THRESHOLD } from './QuotaMeter';
import type { QuotaPool } from '../pool';
import styles from './QuotaPoolSummary.module.scss';

export interface QuotaPoolSummaryProps {
  pools: QuotaPool[];
  now: number;
  resolvedTheme: ResolvedTheme;
}

const levelClass = (remaining: number) =>
  remaining >= QUOTA_PROGRESS_HIGH_THRESHOLD
    ? styles.segmentHigh
    : remaining >= QUOTA_PROGRESS_MEDIUM_THRESHOLD
      ? styles.segmentMedium
      : styles.segmentLow;

const formatPercent = (value: number) => `${Math.round(value)}%`;

export function QuotaPoolSummary({ pools, now, resolvedTheme }: QuotaPoolSummaryProps) {
  const { t, i18n } = useTranslation();
  if (pools.length === 0) return null;

  return (
    <section className={styles.summary} aria-label={t('quota_management.pool_title')}>
      {pools.map((pool) => {
        const icon = getAuthFileIcon(pool.type, resolvedTheme);
        const label = pool.labelKey ? t(pool.labelKey) : pool.label;
        const reset = pool.nextReset
          ? buildResetDisplay(null, pool.nextReset.atMs, now, i18n.language)
          : null;
        const waiting = pool.loadedCount === 0;

        return (
          <article key={pool.key} className={styles.card}>
            <header className={styles.cardHeader}>
              <span className={styles.provider}>
                {icon && <img src={icon} alt="" width={18} height={18} className={styles.icon} />}
                {getTypeLabel(t, pool.type)}
              </span>
              <span className={styles.accounts}>
                {t('quota_management.pool_accounts', { count: pool.accountCount })}
              </span>
            </header>

            <div className={styles.windowLabel}>{label ?? t('quota_management.pool_weekly')}</div>

            {waiting ? (
              <p className={styles.waiting}>{t('quota_management.pool_waiting')}</p>
            ) : (
              <>
                <p className={styles.total}>
                  <span className={styles.totalValue}>{formatPercent(pool.remaining)}</span>
                  <span className={styles.totalOf}>
                    {t('quota_management.pool_of', { capacity: formatPercent(pool.capacity) })}
                  </span>
                </p>

                <div
                  className={styles.segments}
                  role="img"
                  aria-label={pool.segments
                    .map((segment) => `${segment.name}: ${formatPercent(segment.remaining)}`)
                    .join(', ')}
                >
                  {pool.segments.map((segment) => (
                    <span key={segment.key} className={styles.segment} title={segment.name}>
                      <span
                        className={`${styles.segmentFill} ${levelClass(segment.remaining)}`}
                        style={{ width: `${segment.remaining}%` }}
                      />
                    </span>
                  ))}
                </div>

                <dl className={styles.facts}>
                  <div className={styles.fact}>
                    <dt>{t('quota_management.pool_next_reset')}</dt>
                    <dd>
                      {reset && pool.nextReset ? (
                        <span title={reset.absolute}>
                          <span className={styles.regain}>
                            +{formatPercent(pool.nextReset.regain)}
                          </span>{' '}
                          {reset.relative ?? reset.absolute}
                        </span>
                      ) : (
                        <span className={styles.muted}>{t('quota_management.pool_full')}</span>
                      )}
                    </dd>
                  </div>
                  {pool.sessionReported > 0 && (
                    <div className={styles.fact}>
                      <dt>{t('quota_management.pool_session')}</dt>
                      <dd>
                        {t('quota_management.pool_session_value', {
                          available: pool.sessionAvailable,
                          total: pool.sessionReported,
                        })}
                      </dd>
                    </div>
                  )}
                </dl>
                {pool.loadedCount < pool.accountCount && (
                  <p className={styles.partial}>
                    {t('quota_management.pool_partial', {
                      loaded: pool.loadedCount,
                      total: pool.accountCount,
                    })}
                  </p>
                )}
              </>
            )}
          </article>
        );
      })}
    </section>
  );
}
