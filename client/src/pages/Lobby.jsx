import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import Icon from '../components/Icons.jsx';
import CodeTicket from '../components/CodeTicket.jsx';
import { useAudioLevel } from '../hooks/useAudioLevel.js';
import { mediaErrorMessage } from '../utils/format.js';

const hasMedia = () => Boolean(navigator.mediaDevices?.getUserMedia);

/** Pre-join screen: preview, level meter, device pickers, and a way in even without a camera. */
export default function Lobby({ meeting, onJoin }) {
  const [audioOn, setAudioOn] = useState(true);
  const [videoOn, setVideoOn] = useState(true);
  const [devices, setDevices] = useState({ audio: [], video: [] });
  const [audioDeviceId, setAudioDeviceId] = useState('');
  const [videoDeviceId, setVideoDeviceId] = useState('');
  const [stream, setStream] = useState(null);
  const [errors, setErrors] = useState({ audio: '', video: '' });
  const [copiedText, setCopiedText] = useState('');
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const level = useAudioLevel(stream);

  const full = meeting.count >= meeting.capacity;
  const lockedOut = meeting.locked && !meeting.isHost;
  const blocked = full || lockedOut;

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setStream(null);
  }, []);

  // (Re)start the preview whenever the toggles or the chosen devices change.
  useEffect(() => {
    let cancelled = false;
    async function start() {
      stop();
      if (!hasMedia() || (!audioOn && !videoOn)) return;
      const attempt = async (constraints) => navigator.mediaDevices.getUserMedia(constraints);
      let next = null;
      const nextErrors = { audio: '', video: '' };
      try {
        next = await attempt({
          audio: audioOn ? (audioDeviceId ? { deviceId: { exact: audioDeviceId } } : true) : false,
          video: videoOn ? (videoDeviceId ? { deviceId: { exact: videoDeviceId } } : { width: 1280, height: 720 }) : false,
        });
      } catch (err) {
        // One of the two failed. Try each on its own so one broken device does not block the other.
        if (audioOn) {
          try { next = await attempt({ audio: audioDeviceId ? { deviceId: { exact: audioDeviceId } } : true }); } catch (e) { nextErrors.audio = mediaErrorMessage(e, 'microphone'); }
        }
        if (videoOn) {
          try {
            const v = await attempt({ video: videoDeviceId ? { deviceId: { exact: videoDeviceId } } : true });
            if (next) v.getVideoTracks().forEach((t) => next.addTrack(t));
            else next = v;
          } catch (e) { nextErrors.video = mediaErrorMessage(e, 'camera'); }
        }
        if (!next && !nextErrors.audio && !nextErrors.video) nextErrors.video = mediaErrorMessage(err);
      }
      if (cancelled) { next?.getTracks().forEach((t) => t.stop()); return; }
      streamRef.current = next;
      setStream(next);
      setErrors(nextErrors);
      const list = await navigator.mediaDevices.enumerateDevices().catch(() => []);
      if (!cancelled) {
        setDevices({ audio: list.filter((d) => d.kind === 'audioinput'), video: list.filter((d) => d.kind === 'videoinput') });
      }
    }
    start();
    return () => { cancelled = true; };
  }, [audioOn, videoOn, audioDeviceId, videoDeviceId, stop]);

  useEffect(() => stop, [stop]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = stream && stream.getVideoTracks().length ? stream : null;
  }, [stream]);

  function join() {
    // Release the preview first: the meeting opens the devices again through the media server.
    const gotAudio = Boolean(stream?.getAudioTracks().length);
    const gotVideo = Boolean(stream?.getVideoTracks().length);
    stop();
    onJoin({
      audio: audioOn && gotAudio,
      video: videoOn && gotVideo,
      audioDeviceId: audioDeviceId || undefined,
      videoDeviceId: videoDeviceId || undefined,
    });
  }

  const showVideo = videoOn && stream?.getVideoTracks().length > 0;
  const mediaProblem = errors.audio || errors.video || (!hasMedia() && 'Camera and microphone need HTTPS or localhost, and a supported browser. You can still join and watch.');

  return (
    <div className="page">
      <header className="topbar">
        <Link to="/" className="brand"><span className="brand-mark" />Huddle</Link>
      </header>
      <main className="lobby">
        <section className="lobby-preview">
          <div className={`preview${showVideo ? '' : ' no-video'}`}>
            <video ref={videoRef} autoPlay playsInline muted className="preview-video" />
            {!showVideo && (
              <div className="preview-off">
                <Icon name={videoOn ? 'alert' : 'videoOff'} size={34} />
                <p>{videoOn ? 'Camera not available' : 'Camera is off'}</p>
              </div>
            )}
            <div className="preview-controls">
              <button type="button" className={`dock-btn${audioOn ? '' : ' off'}`} onClick={() => setAudioOn((v) => !v)} aria-label={audioOn ? 'Turn microphone off' : 'Turn microphone on'} aria-pressed={audioOn} data-tip={audioOn ? 'Mute' : 'Unmute'}>
                <Icon name={audioOn ? 'mic' : 'micOff'} size={22} />
              </button>
              <button type="button" className={`dock-btn${videoOn ? '' : ' off'}`} onClick={() => setVideoOn((v) => !v)} aria-label={videoOn ? 'Turn camera off' : 'Turn camera on'} aria-pressed={videoOn} data-tip={videoOn ? 'Camera off' : 'Camera on'}>
                <Icon name={videoOn ? 'video' : 'videoOff'} size={22} />
              </button>
            </div>
            <div className="meter" aria-hidden="true" title="Microphone level">
              {Array.from({ length: 10 }, (_, i) => <span key={i} className={level * 10 > i ? 'on' : ''} />)}
            </div>
          </div>
          {mediaProblem && <p className="form-error" role="alert"><Icon name="alert" size={16} />{mediaProblem}</p>}
        </section>

        <section className="card lobby-card">
          <h1>{meeting.title || 'Ready to join?'}</h1>
          <div className="lobby-meta">
            <CodeTicket code={meeting.code} onCopied={setCopiedText} />
            <span className="chip"><Icon name="people" size={13} />{meeting.count} of {meeting.capacity} in the room</span>
            {meeting.locked && <span className="chip chip-amber"><Icon name="lock" size={12} />Locked</span>}
          </div>
          {copiedText && <p className="muted small" aria-live="polite">{copiedText}</p>}

          {lockedOut && <p className="form-error" role="alert"><Icon name="lock" size={16} />The host locked this meeting, so new people cannot join.</p>}
          {full && !lockedOut && <p className="form-error" role="alert"><Icon name="people" size={16} />This meeting is full.</p>}

          {devices.audio.length > 0 && (
            <label className="field">
              <span>Microphone</span>
              <select className="input" value={audioDeviceId} onChange={(e) => setAudioDeviceId(e.target.value)}>
                <option value="">Default microphone</option>
                {devices.audio.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || 'Microphone'}</option>)}
              </select>
            </label>
          )}
          {devices.video.length > 0 && (
            <label className="field">
              <span>Camera</span>
              <select className="input" value={videoDeviceId} onChange={(e) => setVideoDeviceId(e.target.value)}>
                <option value="">Default camera</option>
                {devices.video.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || 'Camera'}</option>)}
              </select>
            </label>
          )}

          <button type="button" className="btn btn-primary btn-wide btn-lg" onClick={join} disabled={blocked}>Join meeting</button>
          <p className="muted small">Camera and microphone are optional. You can join without them and turn them on later.</p>
        </section>
      </main>
    </div>
  );
}
