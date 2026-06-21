import { Icon } from './Icon';

// Build stamp (injected by vite). Lets you confirm a fresh build is loaded after a reload.
const BUILD = typeof __BUILD__ === 'undefined' ? 'dev' : __BUILD__;

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
          <div className="brand-sub" title={`build ${BUILD}`}>on-device · build {BUILD}</div>
        </div>
      </div>
      <span className="pill pill-lock" title="Everything runs on your machine — nothing leaves the device.">
        <Icon name="lock" size={11} /> Local · Private
      </span>
    </header>
  );
}
