import { AGE_BUCKETS } from '@po/contracts';
import { describe, expect, it } from 'vitest';
import {
  AGE_BUCKET_LABELS,
  NO_MATCHING_ORDERS,
  NOTHING_OUTSTANDING,
  ageText,
  asOfLine,
  openLinesText,
} from '../src/pages/reports/report-words';

// The outstanding report's words, in one place (specs/008-outstanding-report/contracts/
// ui.md): age bands, ages, the as-of line and the empty states.

describe('[FR-RPT-01] the outstanding report words', () => {
  it('[FR-RPT-01] a label for every age band, in order', () => {
    expect(AGE_BUCKETS.map((bucket) => AGE_BUCKET_LABELS[bucket])).toEqual([
      '0–30 days',
      '31–60 days',
      '61–90 days',
      'Over 90 days',
    ]);
  });

  it('[FR-RPT-01] an age reads today, 1 day or n days', () => {
    expect(ageText(0)).toBe('today');
    expect(ageText(1)).toBe('1 day');
    expect(ageText(91)).toBe('91 days');
  });

  it('[FR-RPT-01] the as-of line names the India date', () => {
    expect(asOfLine('2026-11-26')).toBe('Ages as of 26 November 2026 (India time)');
  });

  it('[FR-RPT-01] open lines and the empty states', () => {
    expect(openLinesText(2, 5)).toBe('2 of 5');
    expect(NOTHING_OUTSTANDING).toBe('Nothing is outstanding.');
    expect(NO_MATCHING_ORDERS).toBe('No outstanding orders match these filters.');
  });
});
