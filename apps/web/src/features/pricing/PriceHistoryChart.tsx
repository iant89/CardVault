import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { money } from '../../services/api';

export interface HistoryPoint {
  day: string;
  soldMedian: number | null;
  soldAverage: number | null;
  listedMedian: number | null;
  market: number | null;
}

/** Sold median (primary) vs listed median vs aggregator market price. */
export function PriceHistoryChart({ data }: { data: HistoryPoint[] }) {
  if (!data.length) return <div className="empty faint">No price history yet — research runs in the background.</div>;
  const has = (k: keyof HistoryPoint) => data.some((d) => d[k] != null);
  return (
    <div className="chart-box">
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="rgba(148,163,196,.1)" vertical={false} />
          <XAxis dataKey="day" tick={{ fill: '#6f7a92', fontSize: 11 }} tickFormatter={(d: string) => new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} minTickGap={30} />
          <YAxis tick={{ fill: '#6f7a92', fontSize: 11 }} tickFormatter={(v: number) => `$${v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(0)}`} width={52} domain={['auto', 'auto']} />
          <Tooltip
            formatter={(v) => money(Number(v))}
            labelFormatter={(d) => new Date(String(d)).toLocaleDateString()}
            contentStyle={{ background: '#161d2c', border: '1px solid #2a3550', borderRadius: 10 }}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          {has('soldMedian') && <Line type="monotone" dataKey="soldMedian" name="Sold median" stroke="#6ea8ff" strokeWidth={2.4} dot={false} connectNulls />}
          {has('market') && <Line type="monotone" dataKey="market" name="Market" stroke="#3ddc97" strokeWidth={2} dot={false} connectNulls />}
          {has('listedMedian') && <Line type="monotone" dataKey="listedMedian" name="Listed median" stroke="#a77bff" strokeWidth={1.5} strokeDasharray="4 3" dot={false} connectNulls />}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
