import { useState } from 'react';
import Icon from './Icons.jsx';

function DockButton({ icon, label, shortcut, active, off, danger, badge, onClick, pulse, disabled }) {
  return (
    <button
      type="button"
      className={`dock-btn${active ? ' active' : ''}${off ? ' off' : ''}${danger ? ' danger' : ''}${pulse ? ' pulse' : ''}`}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={active === undefined ? undefined : Boolean(active)}
      data-tip={shortcut ? `${label} (${shortcut})` : label}
    >
      <Icon name={icon} size={22} />
      {badge > 0 && <span className="dock-badge">{badge > 9 ? '9+' : badge}</span>}
    </button>
  );
}

/** The floating control bar. Buttons reflect real state and are only shown if they can work. */
export default function ControlDock({
  micOn, camOn, speaking, sharing, handUp, layout, panel, unreadChat, peopleCount, isHost, viewerOnly,
  onMic, onCamera, onShare, onHand, onLayout, onPanel, onLeave, onEndForAll,
}) {
  const [leaveOpen, setLeaveOpen] = useState(false);

  return (
    <div className="dock" role="toolbar" aria-label="Meeting controls">
      <DockButton icon={micOn ? 'mic' : 'micOff'} label={micOn ? 'Mute' : 'Unmute'} shortcut="M" off={!micOn} pulse={micOn && speaking} onClick={onMic} disabled={viewerOnly} />
      <DockButton icon={camOn ? 'video' : 'videoOff'} label={camOn ? 'Turn camera off' : 'Turn camera on'} shortcut="V" off={!camOn} onClick={onCamera} disabled={viewerOnly} />
      <DockButton icon="screen" label={sharing ? 'Stop sharing' : 'Share screen'} shortcut="S" active={sharing} onClick={onShare} disabled={viewerOnly} />
      <DockButton icon="hand" label={handUp ? 'Lower hand' : 'Raise hand'} shortcut="H" active={handUp} onClick={onHand} />
      <span className="dock-sep" aria-hidden="true" />
      <DockButton icon={layout === 'gallery' ? 'speaker' : 'grid'} label={layout === 'gallery' ? 'Speaker view' : 'Gallery view'} shortcut="G" onClick={onLayout} />
      <DockButton icon="people" label="People" shortcut="P" active={panel === 'people'} badge={0} onClick={() => onPanel('people')} />
      <DockButton icon="chat" label="Chat" shortcut="C" active={panel === 'chat'} badge={panel === 'chat' ? 0 : unreadChat} onClick={() => onPanel('chat')} />
      <span className="dock-count" aria-label={`${peopleCount} people`}>{peopleCount}</span>
      <span className="dock-sep" aria-hidden="true" />
      <div className="dock-leave">
        <button
          type="button"
          className="dock-btn danger wide"
          onClick={() => (isHost ? setLeaveOpen((v) => !v) : onLeave())}
          aria-haspopup={isHost ? 'menu' : undefined}
          aria-expanded={isHost ? leaveOpen : undefined}
          aria-label="Leave meeting"
          data-tip="Leave"
        >
          <Icon name="leave" size={22} />
        </button>
        {leaveOpen && (
          <div className="leave-menu" role="menu">
            <button type="button" role="menuitem" onClick={() => { setLeaveOpen(false); onLeave(); }}>
              <Icon name="logout" size={18} />
              <span><strong>Leave meeting</strong><small>Someone else becomes the host</small></span>
            </button>
            <button type="button" role="menuitem" className="menu-danger" onClick={() => { setLeaveOpen(false); onEndForAll(); }}>
              <Icon name="stop" size={18} />
              <span><strong>End for everyone</strong><small>Disconnects all participants</small></span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
