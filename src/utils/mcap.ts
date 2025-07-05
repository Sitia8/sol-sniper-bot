/**
 * Compute market cap from LP reserves.
 * Simple approximation: mcap = circulating * price; here assuming 50/50 pool:
 *   mcap ≈ 2 * quote_reserve
 */
export function marketCapFromLp(quoteReserve: number): number {
  return 2 * quoteReserve;
}

export function percentChange(from: number, to: number): number {
  return (to - from) / from;
}
