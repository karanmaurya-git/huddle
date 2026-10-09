import { Link } from 'react-router-dom';
import Icon from './Icons.jsx';

const KINDS = {
  removed: { icon: 'close', title: 'You were removed from this meeting', text: 'The host removed you, so you cannot rejoin this one.' },
  replaced: { icon: 'copy', title: 'This meeting is open in another tab', text: 'Only one tab can be in a meeting at a time. Close the other tab, or join again here.' },
  ended: { icon: 'stop', title: 'This meeting has ended', text: 'The host ended it. You can start a new meeting any time.' },
  notfound: { icon: 'link', title: 'Meeting not found', text: 'Check the code, or ask the host for a fresh invite link.' },
  full: { icon: 'people', title: 'This meeting is full', text: 'It has reached its maximum number of people. Ask the host to make space.' },
  locked: { icon: 'lock', title: 'The host locked this meeting', text: 'New people cannot join right now. Ask the host to unlock it.' },
  failed: { icon: 'alert', title: 'Media connection lost', text: 'We could not restore your audio and video. Leave and rejoin to try again.' },
  error: { icon: 'alert', title: 'Something went wrong', text: 'We could not open this meeting. Try again in a moment.' },
};

export default function NoticeScreen({ kind = 'error', message, action }) {
  const info = KINDS[kind] || KINDS.error;
  return (
    <main className="notice">
      <div className="notice-card">
        <span className="notice-icon"><Icon name={info.icon} size={30} /></span>
        <h1>{info.title}</h1>
        <p>{message && message !== info.title ? message : info.text}</p>
        <div className="notice-actions">
          {action}
          <Link className="btn btn-primary" to="/">Back to dashboard</Link>
        </div>
      </div>
    </main>
  );
}
