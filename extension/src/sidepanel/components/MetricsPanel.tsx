import type { MetricsSnapshot } from '@/shared/messages';
import { Icon } from './Icon';

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function MetricsPanel({ metrics }: { metrics: MetricsSnapshot | null }) {
  if (!metrics || metrics.ops.length === 0) {
    return (
      <div className="empty">
        <div className="empty-mark">
          <Icon name="gauge" size={22} />
        </div>
        <div className="empty-title">No metrics yet</div>
        <div className="empty-text">Run a task and per-operation latency will collect here.</div>
      </div>
    );
  }

  const totalN = metrics.ops.reduce((a, o) => a + o.n, 0);
  const slowest = [...metrics.ops].sort((a, b) => b.mean - a.mean)[0];

  return (
    <div className="settings">
      <div className="card">
        <div className="metric-summary">
          <div className="metric-stat">
            <span className="v">{totalN}</span>
            <span className="k">calls</span>
          </div>
          <div className="metric-stat">
            <span className="v">{metrics.ops.length}</span>
            <span className="k">operations</span>
          </div>
          <div className="metric-stat">
            <span className="v">{fmtMs(slowest.mean)}</span>
            <span className="k">slowest mean</span>
          </div>
        </div>
        <div className="table-scroll">
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
      </div>
    </div>
  );
}
