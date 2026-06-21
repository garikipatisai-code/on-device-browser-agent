import type { ReactNode } from 'react';
import { Icon } from './Icon';

/** Inline notice for preflight failures / errors, with an icon and remediation text. */
export function Alert({ kind, children }: { kind: 'warn' | 'error'; children: ReactNode }) {
  return (
    <div className={`alert ${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <span className="alert-icon">
        <Icon name="alert" size={16} />
      </span>
      <div>{children}</div>
    </div>
  );
}
