import type { MetricsSnapshot } from '@/shared/messages';

export function MetricsPanel({ metrics }: { metrics: MetricsSnapshot | null }) {
  if (!metrics || metrics.ops.length === 0) {
    return (
      <div className="settings">
        <div style={{ color: 'var(--fg-mute)', textAlign: 'center', padding: 20 }}>
          No metrics yet. Run a task to collect data.
        </div>
      </div>
    );
  }
  return (
    <div className="settings">
      <div className="section-head">Per-operation latency</div>
      <table className="metrics-table">
        <thead>
          <tr>
            <th>Op</th>
            <th>N</th>
            <th>OK</th>
            <th>p50</th>
            <th>Mean</th>
          </tr>
        </thead>
        <tbody>
          {metrics.ops.map((o) => (
            <tr key={o.op}>
              <td>{o.op}</td>
              <td>{o.n}</td>
              <td>{o.ok}</td>
              <td>{fmtMs(o.p50)}</td>
              <td>{fmtMs(o.mean)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
