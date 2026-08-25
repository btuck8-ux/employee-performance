/**
 * The /api/scores paging boundary math, extracted pure so the 1,000/1,001
 * edge — the exact boundary neither side had ever crossed in five months —
 * is unit-tested instead of assumed (THQ paging contract, 2026-08-25 §4).
 *
 * THQ's fix reads pagination.has_more, pagination.offset and
 * pagination.count from the envelope { data, pagination: { limit, offset,
 * count, has_more } }; offset is the paging parameter. This module is that
 * envelope's arithmetic, and the contract pins hold the route to it.
 */

/**
 * True when rows remain past this page. `total` is the exact count for the
 * filtered query; `returned` is the rows in THIS response.
 */
export function hasMore(offset: number, returned: number, total: number): boolean {
  return offset + returned < total;
}
