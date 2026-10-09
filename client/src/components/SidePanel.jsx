import Icon from './Icons.jsx';

export default function SidePanel({ panel, onClose, onTab, peopleCount, unreadChat, children }) {
  return (
    <aside className={`side-panel${panel ? ' open' : ''}`} aria-hidden={!panel} aria-label="Meeting panel">
      <div className="side-head">
        <div className="tabs" role="tablist">
          <button type="button" role="tab" aria-selected={panel === 'people'} className={panel === 'people' ? 'active' : ''} onClick={() => onTab('people')}>
            People <span className="tab-count">{peopleCount}</span>
          </button>
          <button type="button" role="tab" aria-selected={panel === 'chat'} className={panel === 'chat' ? 'active' : ''} onClick={() => onTab('chat')}>
            Chat {unreadChat > 0 && <span className="tab-count hot">{unreadChat}</span>}
          </button>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close panel"><Icon name="close" /></button>
      </div>
      <div className="side-body">{children}</div>
    </aside>
  );
}
