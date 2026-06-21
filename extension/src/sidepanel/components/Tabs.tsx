import { Icon, type IconName } from './Icon';

export type TabId = 'agent' | 'settings' | 'metrics';

const TABS: { id: TabId; label: string; icon: IconName }[] = [
  { id: 'agent', label: 'Agent', icon: 'spark' },
  { id: 'settings', label: 'Settings', icon: 'gear' },
  { id: 'metrics', label: 'Metrics', icon: 'gauge' },
];

export function Tabs({ tab, onTab }: { tab: TabId; onTab: (t: TabId) => void }) {
  return (
    <div className="tabs" role="tablist" aria-label="Sections">
      {TABS.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={tab === t.id}
          className={`tab ${tab === t.id ? 'active' : ''}`}
          onClick={() => onTab(t.id)}
        >
          <Icon name={t.icon} size={14} />
          {t.label}
        </button>
      ))}
    </div>
  );
}
