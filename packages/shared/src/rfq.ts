/**
 * RFQ container default (spec 18): the demand week's containers × the share of
 * the week's live quantity that the RFQ asks for, rounded up, never more than
 * the week has. Used by the builder (preview) and the server (stored default).
 */
export function defaultRfqContainers(weekContainers: number, askedMilli: number, weekLiveMilli: number): number {
  if (weekContainers <= 0 || askedMilli <= 0 || weekLiveMilli <= 0) return 0;
  return Math.min(weekContainers, Math.ceil((weekContainers * askedMilli) / weekLiveMilli - 1e-9));
}
