import { Icon } from './Icon';

/** App header: brand mark + wordmark + the always-on privacy signal. */
export function Brand() {
  return (
    <header className="app-header">
      <div className="brand">
        <div className="brand-mark">
          <Icon name="spark" size={15} />
        </div>
        <div>
          <div className="brand-name">Browser Agent</div>
          <div className="brand-sub">on-device · gemma</div>
        </div>
      </div>
      <span className="pill pill-lock" title="Everything runs on your machine — nothing leaves the device.">
        <Icon name="lock" size={11} /> Local · Private
      </span>
    </header>
  );
}
