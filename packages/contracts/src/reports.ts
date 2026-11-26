// Outstanding orders report constants (specs/008-outstanding-report/data-model.md,
// research R3, ADR-0015 amended 2026-11-26). An order's age is whole calendar days in
// India time (RECEIPT_TIME_ZONE) from its approval date to the report's as-of date.

/** The age bands, youngest first. */
export const AGE_BUCKETS = ['DAYS_0_30', 'DAYS_31_60', 'DAYS_61_90', 'OVER_90'] as const;
export type AgeBucket = (typeof AGE_BUCKETS)[number];

/**
 * Each bounded band's inclusive upper age in days, in AGE_BUCKETS order: an order exactly
 * 30 days old is in DAYS_0_30. The last band has no upper bound.
 */
export const AGE_BUCKET_UPPER_DAYS = [30, 60, 90] as const;
