/** Only reviewed=0 is unreviewed; NULL and every nonzero value are protected. */
const REVIEWED_COLUMNS = new Set(["si.reviewed", "d.reviewed", "reviewed"]);

export function isReviewedFlag(value) {
  return value !== 0;
}

export function reviewedSqlPredicate(column, reviewed) {
  if (!REVIEWED_COLUMNS.has(column)) throw new TypeError("Unsupported reviewed SQL column expression");
  return reviewed ? `${column} IS NOT 0` : `${column} = 0`;
}
