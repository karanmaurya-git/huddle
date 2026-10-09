import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getMeeting, errorMessage } from '../services/api.js';
import Lobby from './Lobby.jsx';
import MeetingRoom from './MeetingRoom.jsx';
import NoticeScreen from '../components/NoticeScreen.jsx';

/** /meeting/:code. Looks the meeting up, shows the lobby, then the meeting itself. */
export default function MeetingPage() {
  const code = useParams().code.toUpperCase();
  const [meeting, setMeeting] = useState(null);
  const [failure, setFailure] = useState(null);
  const [prefs, setPrefs] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setMeeting(null);
    setFailure(null);
    setPrefs(null);
    getMeeting(code)
      .then((m) => !cancelled && setMeeting(m))
      .catch((err) => {
        if (cancelled) return;
        const status = err.response?.status;
        setFailure({ kind: status === 404 || status === 400 ? 'notfound' : 'error', message: status === 404 ? '' : errorMessage(err) });
      });
    return () => { cancelled = true; };
  }, [code]);

  if (failure) return <NoticeScreen kind={failure.kind} message={failure.message} />;
  if (!meeting) {
    return (
      <main className="notice"><div className="notice-card"><span className="spinner big" aria-label="Loading the meeting" /><h1>Opening the meeting</h1></div></main>
    );
  }
  if (meeting.status === 'ended') return <NoticeScreen kind="ended" />;
  if (!prefs) return <Lobby meeting={meeting} onJoin={setPrefs} />;
  return <MeetingRoom code={code} meeting={meeting} prefs={prefs} />;
}
