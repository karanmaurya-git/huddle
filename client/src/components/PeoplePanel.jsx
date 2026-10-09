import { useMemo, useRef, useState } from 'react';
import Icon from './Icons.jsx';
import Avatar from './Avatar.jsx';
import RoleBadge from './RoleBadge.jsx';
import { computeWindow } from '../meeting/windowList.js';
import { personActions } from '../meeting/capabilities.js';

const ROW = 60;

function Row({ person, media, queueNumber, selected, isMe, onSelect, sharing }) {
  return (
    <li className={`person-row${selected ? ' selected' : ''}`} style={{ height: ROW }}>
      <button type="button" className="person-main" onClick={() => onSelect(person.userId)} aria-pressed={selected} aria-label={`${person.username}, ${person.role}`}>
        <Avatar name={person.username} size={36} />
        <span className="person-text">
          <span className="person-name">{person.username}{isMe && <em> (you)</em>}</span>
          <RoleBadge role={person.role} />
        </span>
        <span className="person-icons">
          {person.handRaised && <span className="chip chip-amber" title={`Hand raised, number ${queueNumber}`}><Icon name="hand" size={13} />{queueNumber}</span>}
          {sharing && <Icon name="screen" size={16} className="state-share" />}
          {media && !media.audioEnabled && <Icon name="micOff" size={16} className="state-off" />}
          {media && !media.videoEnabled && <Icon name="videoOff" size={16} className="state-off" />}
          {media?.isSpeaking && <Icon name="volume" size={16} className="state-speaking" />}
        </span>
      </button>
    </li>
  );
}

/** Windowed list: with 100 people only the rows on screen are rendered. */
export default function PeoplePanel({ participants, me, mediaById, presenterId, capacity, locked, onAction }) {
  const [scrollTop, setScrollTop] = useState(0);
  const [selectedId, setSelectedId] = useState(null);
  const [query, setQuery] = useState('');
  const viewport = useRef(null);

  const queue = useMemo(() => {
    const raised = participants.filter((p) => p.handRaised).sort((a, b) => a.handRaisedAt - b.handRaisedAt);
    return new Map(raised.map((p, i) => [p.userId, i + 1]));
  }, [participants]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? participants.filter((p) => p.username.toLowerCase().includes(q)) : participants;
    // Raised hands first (in queue order), then the server's order (Host, Moderators, joined order).
    return [...list].sort((a, b) => (queue.get(a.userId) ?? 999) - (queue.get(b.userId) ?? 999));
  }, [participants, query, queue]);

  const win = computeWindow({ scrollTop, viewportHeight: viewport.current?.clientHeight || 480, rowHeight: ROW, total: filtered.length });
  const selected = participants.find((p) => p.userId === selectedId);
  const actions = selected ? personActions(me, selected, { isSharing: presenterId === selected.userId }) : null;
  const hasActions = actions && Object.values(actions).some(Boolean);

  return (
    <div className="people">
      <div className="people-head">
        <div className="people-count">
          <strong>{participants.length}</strong> of {capacity} in the meeting
          {locked && <span className="chip chip-amber"><Icon name="lock" size={12} />Locked</span>}
        </div>
        {participants.length > 8 && (
          <input className="input input-small" type="search" placeholder="Find a person" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Find a person" />
        )}
      </div>

      <div className="people-scroll" ref={viewport} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
        <ul className="people-list" style={{ height: win.totalHeight }}>
          <div style={{ transform: `translateY(${win.offsetTop}px)` }}>
            {filtered.slice(win.start, win.end).map((p) => (
              <Row
                key={p.userId}
                person={p}
                media={mediaById.get(p.userId)}
                queueNumber={queue.get(p.userId)}
                selected={selectedId === p.userId}
                isMe={p.userId === me.userId}
                sharing={presenterId === p.userId}
                onSelect={(id) => setSelectedId((cur) => (cur === id ? null : id))}
              />
            ))}
          </div>
        </ul>
        {filtered.length === 0 && <p className="empty">Nobody matches that name.</p>}
      </div>

      {selected && (
        <div className="person-actions" role="group" aria-label={`Actions for ${selected.username}`}>
          <div className="person-actions-title">
            <strong>{selected.username}</strong>
            <button type="button" className="icon-btn" onClick={() => setSelectedId(null)} aria-label="Close actions"><Icon name="close" size={16} /></button>
          </div>
          {!hasActions && <p className="muted small">{selected.userId === me.userId ? 'This is you.' : 'You have no actions for this person.'}</p>}
          {hasActions && (
            <div className="action-grid">
              {actions.mute && <button type="button" className="btn btn-small" onClick={() => onAction('mute_participant', selected)}><Icon name="micOff" size={16} />Mute</button>}
              {actions.lowerHand && <button type="button" className="btn btn-small" onClick={() => onAction('lower_hand', selected)}><Icon name="hand" size={16} />Lower hand</button>}
              {actions.stopShare && <button type="button" className="btn btn-small" onClick={() => onAction('stop_screen_share_for', selected)}><Icon name="screen" size={16} />Stop sharing</button>}
              {actions.makeModerator && <button type="button" className="btn btn-small" onClick={() => onAction('assign_role', selected, { role: 'moderator' })}><Icon name="shield" size={16} />Make moderator</button>}
              {actions.makeParticipant && <button type="button" className="btn btn-small" onClick={() => onAction('assign_role', selected, { role: 'participant' })}><Icon name="user" size={16} />Make participant</button>}
              {actions.makeHost && <button type="button" className="btn btn-small" onClick={() => onAction('transfer_host', selected, {}, true)}><Icon name="crown" size={16} />Make host</button>}
              {actions.remove && <button type="button" className="btn btn-small btn-danger" onClick={() => onAction('remove_participant', selected, {}, true)}><Icon name="trash" size={16} />Remove</button>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
