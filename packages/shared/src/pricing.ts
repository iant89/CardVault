export interface PricePoint {
  /** total price in minor units is avoided; we use decimal dollars as number */
  price: number;
  shipping?: number | null;
  observedAt: Date | string;
  saleType: string;
}

export interface PriceStats {
  count: number;
  average: number | null;
  median: number | null;
  min: number | null;
  max: number | null;
  stdDev: number | null;
  /** coefficient of variation (stdDev / mean), 0..∞ */
  volatility: number | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function stats(values: number[]): PriceStats {
  if (values.length === 0) {
    return { count: 0, average: null, median: null, min: null, max: null, stdDev: null, volatility: null };
  }
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, v) => a + (v - avg) ** 2, 0) / values.length;
  const sd = Math.sqrt(variance);
  return {
    count: values.length,
    average: round2(avg),
    median: round2(median(values)!),
    min: round2(Math.min(...values)),
    max: round2(Math.max(...values)),
    stdDev: round2(sd),
    volatility: avg > 0 ? Math.round((sd / avg) * 1000) / 1000 : null,
  };
}

/**
 * Remove extreme outliers with the IQR rule (1.5×IQR fences). Only applied
 * when there are enough points for quartiles to be meaningful.
 */
export function withoutOutliers(values: number[]): number[] {
  if (values.length < 5) return values;
  const s = [...values].sort((a, b) => a - b);
  const q = (p: number) => {
    const pos = (s.length - 1) * p;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
  };
  const q1 = q(0.25);
  const q3 = q(0.75);
  const iqr = q3 - q1;
  return s.filter((v) => v >= q1 - 1.5 * iqr && v <= q3 + 1.5 * iqr);
}

const total = (p: PricePoint) => p.price + (p.shipping ?? 0);
const ts = (p: PricePoint) => new Date(p.observedAt).getTime();
const DAY = 86_400_000;

export interface MarketSummary {
  marketPrice: number | null;
  listed: PriceStats;
  sold: PriceStats;
  avg30d: number | null;
  avg90d: number | null;
  avg1y: number | null;
  recentSoldAverage: number | null;
  recentSoldMedian: number | null;
  /** percent change in sold median, last 30d vs prior 30d */
  trend30d: number | null;
  volatility: number | null;
}

export const SOLD_TYPES = new Set(['SOLD', 'AUCTION']);

/**
 * Compute the full market summary. Listed and sold prices are kept separate.
 * Market price prefers recent sold median (robust to single abnormal sales),
 * then aggregator "MARKET" prices, then the low quartile of active listings.
 */
export function summarize(points: PricePoint[], now: Date = new Date()): MarketSummary {
  const n = now.getTime();
  const sold = points.filter((p) => SOLD_TYPES.has(p.saleType));
  const listed = points.filter((p) => p.saleType === 'LISTING' || p.saleType === 'BUY_IT_NOW');
  const market = points.filter((p) => p.saleType === 'MARKET');

  const within = (arr: PricePoint[], days: number, offsetDays = 0) =>
    arr.filter((p) => {
      const age = n - ts(p);
      return age >= offsetDays * DAY && age < (offsetDays + days) * DAY;
    });

  const soldVals = withoutOutliers(sold.map(total));
  const recentSold = withoutOutliers(within(sold, 30).map(total));
  const priorSold = withoutOutliers(within(sold, 30, 30).map(total));
  const all = [...sold, ...market];

  const avgOf = (arr: PricePoint[]) => stats(withoutOutliers(arr.map(total))).average;

  let marketPrice: number | null = null;
  const recentSoldMedian = median(recentSold);
  if (recentSoldMedian != null) marketPrice = recentSoldMedian;
  else {
    const recentMarket = [...market].sort((a, b) => ts(b) - ts(a))[0];
    if (recentMarket) marketPrice = total(recentMarket);
    else if (soldVals.length) marketPrice = median(soldVals);
    else if (listed.length) {
      const l = [...listed.map(total)].sort((a, b) => a - b);
      marketPrice = l[Math.floor((l.length - 1) * 0.25)]!;
    }
  }

  const priorMedian = median(priorSold);
  const trend =
    recentSoldMedian != null && priorMedian != null && priorMedian > 0
      ? Math.round(((recentSoldMedian - priorMedian) / priorMedian) * 1000) / 10
      : null;

  const soldStats = stats(soldVals);
  return {
    marketPrice: marketPrice == null ? null : round2(marketPrice),
    listed: stats(listed.map(total)),
    sold: soldStats,
    avg30d: avgOf(within(all, 30)),
    avg90d: avgOf(within(all, 90)),
    avg1y: avgOf(within(all, 365)),
    recentSoldAverage: stats(recentSold).average,
    recentSoldMedian: recentSoldMedian == null ? null : round2(recentSoldMedian),
    trend30d: trend,
    volatility: soldStats.volatility,
  };
}
