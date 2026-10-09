import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { createMeeting, deleteMeeting, errorMessage, getMeeting, listMeetings } from '../services/api.js';
import { timeAgo } from '../utils/format.js';
import Icon from '../components/Icons.jsx';
import Avatar from '../components/Avatar.jsx';
import ConfirmDialog from '../components/ConfirmDialog.jsx';
import Toasts from '../components/Toasts.jsx';
import { useToasts } from '../hooks/useToasts.js';

function MeetingCard({ meeting, onOpen, onCopy, onDelete }) {
  const ended = meeting.status === 'ended';
  return (
    <li className={`meeting-card${ended ? ' ended' : ''}`}>
      <div className="meeting-card-top">
        <span className="code-chip">{meeting.code}</span>
        {ended ? <span className="chip">Ended</span> : meeting.live > 0 ? <span className="chip chip-live"><i />Live, {meeting.live} in the room</span> : <span className="chip chip-ready">Ready</span>}
        {meeting.locked && !ended && <span className="chip chip-amber"><Icon name="lock" size={12} />Locked</span>}
      </div>
      <h3>{meeting.title || 'Untitled meeting'}</h3>
      <p className="muted small">{meeting.isHost ? 'You host this meeting' : 'You joined this meeting'}. {timeAgo(meeting.lastJoinedAt)}.</p>
      <div className="meeting-card-actions">
        <button type="button" className="btn btn-primary btn-small" onClick={() => onOpen(meeting.code)} disabled={ended}>{ended ? 'Ended' : 'Join'}</button>
        <button type="button" className="icon-btn" onClick={() => onCopy(meeting.code)} aria-label={`Copy invite link for ${meeting.code}`} title="Copy invite link"><Icon name="link" size={18} /></button>
        {meeting.isHost && <button type="button" className="icon-btn danger" onClick={() => onDelete(meeting)} aria-label={`Delete meeting ${meeting.code}`} title="Delete meeting"><Icon name="trash" size={18} /></button>}
      </div>
    </li>
  );
}

export default function Dashboard() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const { toasts, push, dismiss } = useToasts();
  const [title, setTitle] = useState('');
  const [code, setCode] = useState('');
  const [meetings, setMeetings] = useState(null);
  const [error, setError] = useState('');
  const [joinError, setJoinError] = useState('');
  const [busy, setBusy] = useState(false);
  const [toDelete, setToDelete] = useState(null);

  useEffect(() => {
    listMeetings().then(setMeetings).catch(() => setMeetings([]));
  }, []);

  async function handleCreate(event) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const meeting = await createMeeting(title.trim());
      navigate(`/meeting/${meeting.code}`);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  async function handleJoin(event) {
    event.preventDefault();
    setJoinError('');
    const value = code.trim().toUpperCase();
    try {
      const meeting = await getMeeting(value); // check first so a typo is caught here
      if (meeting.status === 'ended') return setJoinError('That meeting has ended.');
      return navigate(`/meeting/${value}`);
    } catch (err) {
      return setJoinError(err.response?.status === 404 ? 'No meeting has that code. Check it and try again.' : errorMessage(err));
    }
  }

  async function confirmDelete() {
    const target = toDelete;
    setToDelete(null);
    try {
      await deleteMeeting(target.code);
      setMeetings((list) => list.filter((m) => m.code !== target.code));
      push(`Meeting ${target.code} deleted`, 'success');
    } catch (err) {
      push(errorMessage(err), 'error');
    }
  }

  const copy = async (c) => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/meeting/${c}`);
      push('Invite link copied', 'success');
    } catch {
      push(`${window.location.origin}/meeting/${c}`);
    }
  };

  const firstName = user?.name?.split(' ')[0] || 'there';

  return (
    <div className="page">
      <header className="topbar">
        <span className="brand"><span className="brand-mark" />Huddle</span>
        <div className="topbar-right">
          <span className="user-chip"><Avatar name={user?.name} size={30} /><span>{user?.name}</span></span>
          <button type="button" className="btn btn-ghost btn-small" onClick={logout}><Icon name="logout" size={16} />Log out</button>
        </div>
      </header>

      <main className="dashboard">
        <section className="hero">
          <h1>Good to see you, {firstName}.</h1>
          <p className="muted">Start a meeting in a click, or jump into one with a code.</p>
        </section>

        <section className="actions">
          <form className="card action-card" onSubmit={handleCreate}>
            <span className="card-icon"><Icon name="video" size={26} /></span>
            <h2>Start a meeting</h2>
            <p className="muted">You become the host. Share the code or the invite link.</p>
            <label className="field">
              <span>Title (optional)</span>
              <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} placeholder="Weekly sync" />
            </label>
            {error && <p className="form-error" role="alert"><Icon name="alert" size={16} />{error}</p>}
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? <span className="spinner" aria-label="Creating" /> : <><Icon name="plus" size={18} />New meeting</>}
            </button>
          </form>

          <form className="card action-card" onSubmit={handleJoin}>
            <span className="card-icon alt"><Icon name="link" size={26} /></span>
            <h2>Join with a code</h2>
            <p className="muted">Enter the 6-character code you were given.</p>
            <label className="field">
              <span>Meeting code</span>
              <input
                className={`input code-input${joinError ? ' shake' : ''}`}
                value={code}
                onChange={(e) => { setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '')); setJoinError(''); }}
                maxLength={6}
                placeholder="ABC234"
                aria-label="Meeting code"
                autoCapitalize="characters"
                spellCheck={false}
              />
            </label>
            {joinError && <p className="form-error" role="alert"><Icon name="alert" size={16} />{joinError}</p>}
            <button type="submit" className="btn btn-primary" disabled={code.length !== 6}>Join meeting</button>
          </form>
        </section>

        <section className="recent">
          <h2>Recent meetings</h2>
          {meetings === null && (
            <ul className="meeting-grid" aria-busy="true">
              {[0, 1, 2].map((i) => <li key={i} className="meeting-card skeleton" aria-hidden="true" />)}
            </ul>
          )}
          {meetings && meetings.length === 0 && (
            <div className="empty-state">
              <Icon name="video" size={28} />
              <p><strong>No meetings yet</strong></p>
              <p className="muted">Meetings you host or join will show up here so you can jump back in.</p>
            </div>
          )}
          {meetings && meetings.length > 0 && (
            <ul className="meeting-grid">
              {meetings.map((m) => (
                <MeetingCard key={m.code} meeting={m} onOpen={(c) => navigate(`/meeting/${c}`)} onCopy={copy} onDelete={setToDelete} />
              ))}
            </ul>
          )}
        </section>
      </main>

      {toDelete && (
        <ConfirmDialog
          title={`Delete meeting ${toDelete.code}?`}
          body="Everyone inside is disconnected and the meeting is removed for good. This cannot be undone."
          confirmLabel="Delete meeting"
          danger
          onConfirm={confirmDelete}
          onCancel={() => setToDelete(null)}
        />
      )}
      <Toasts toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
