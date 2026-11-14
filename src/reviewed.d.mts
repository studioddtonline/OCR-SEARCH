export type ReviewedSqlColumn = "si.reviewed" | "d.reviewed" | "reviewed";
export function isReviewed(value: number | null | undefined): boolean;
/** @deprecated Use isReviewed. */
export const isReviewedFlag: typeof isReviewed;
export function reviewedSqlPredicate(column: ReviewedSqlColumn, reviewed: boolean): string;
