import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useRoomSocket } from '../hooks/useRoomSocket.js';
import { useLiveKitRoom } from '../hooks/useLiveKitRoom.js';
import { useToasts } from '../hooks/useToasts.js';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts.js';
import { planSubscriptions } from '../meeting/subscriptionPlanner.js';
import { isPrivileged, meetingCapabilities } from '../meeting/capabilities.js';
import { PLAN_CONFIG } from '../services/config.js';
import Icon from '../components/Icons.jsx';
import MediaStage from '../components/MediaStage.jsx';
import RemoteAudio from '../components/RemoteAudio.jsx';
import ControlDock from '../components/ControlDock.jsx';
import SidePanel from '../components/SidePanel.jsx';
import PeoplePanel from '../components/PeoplePanel.jsx';
import ChatPanel from '../components/ChatPanel.jsx';
import CodeTicket from '../components/CodeTicket.jsx';
import StatusPills from '../components/StatusPills.jsx';
import MeetingTimer from '../components/MeetingTimer.jsx';
import ConfirmDialog from '../components/ConfirmDialog.jsx';
import NoticeScreen from '../components/NoticeScreen.jsx';
import Toasts from '../components/Toasts.jsx';

const FATAL = new Set(['removed', 'replaced', 'ended', 'notfound', 'full', 'locked', 'error']);
// These errors switch the whole screen (see the reducer), so they need no toast.
const SCREEN_ERRORS = new Set(['ROOM_FULL', 'ROOM_LOCKED', 'MEETING_ENDED', 'REMOVED', 'ROOM_NOT_FOUND']);

export default function MeetingRoom({ code, meeting, prefs }) {
  const navigate = useNavigate();
  const { toasts, push, dismiss } = useToasts();
  const [panel, setPanel] = useState(null);
  const [layout, setLayout] = useState('speaker');
  const [page, setPage] = useState(0);
  const [pinnedId, setPinnedId] = useState(null);
  const [unread, setUnread] = useState(0);
  const [confirm, setConfirm] = useState(null);
  const joinedAt = useRef(Date.now());
  const stateRef = useRef(null);
  const mediaRef = useRef(null);
  const sendRef = useRef(() => false);
  const panelRef = useRef(panel);
  panelRef.current = panel;

  const onEvent = useCallback(
    ({ type, payload }) => {
      const st = stateRef.current;
      const meId = st?.me?.userId;
      const nameOf = (id) => st?.participants.find((p) => p.userId === id)?.username || 'Someone';
      switch (type) {
        case 'user_joined': push(`${payload.username} joined`); break;
        case 'user_left': push(`${payload.username} ${payload.reason === 'timeout' ? 'lost connection' : 'left'}`); break;
        case 'participant_removed': push(`${payload.username} was removed`); break;
        case 'role_assigned': push(payload.userId === meId ? `You are now a ${payload.role}` : `${payload.username} is now a ${payload.role}`); break;
        case 'host_transferred': push(payload.newHostId === meId ? 'You are now the host' : `${payload.newHostName} is now the host`); break;
        case 'room_lock_changed': push(payload.locked ? 'The meeting is locked' : 'The meeting is unlocked'); break;
        case 'hand_changed':
          if (payload.raised && payload.userId !== meId && isPrivileged(st?.me?.role)) push(`${nameOf(payload.userId)} raised a hand`);
          break;
        case 'chat_message':
          if (payload.userId !== meId && panelRef.current !== 'chat') setUnread((n) => n + 1);
          break;
        case 'force_muted':
          mediaRef.current?.muteMic();
          push(`${payload.byName} muted you`);
          break;
        case 'screen_share_granted': mediaRef.current?.startScreenShare(); break;
        case 'screen_share_stopped':
          mediaRef.current?.stopScreenShare();
          push('A moderator stopped your screen share');
          break;
        case 'error':
          if (!SCREEN_ERRORS.has(payload.code)) push(payload.message, 'error');
          break;
        default: break;
      }
    },
    [push]
  );

  const { state, send } = useRoomSocket(code, { onEvent });
  stateRef.current = state;
  sendRef.current = send;

  const media = useLiveKitRoom({
    code,
    enabled: Boolean(state.me) && (state.status === 'connected' || state.status === 'reconnecting'),
    appConnected: state.status === 'connected',
    prefs,
    onNotice: push,
    onShareEnded: () => sendRef.current('screen_share_stop'),
  });
  mediaRef.current = media;

  const me = state.me;
  const appById = useMemo(() => new Map(state.participants.map((p) => [p.userId, p])), [state.participants]);
  const mediaById = useMemo(() => new Map(media.snapshot.participants.map((p) => [p.id, p])), [media.snapshot.participants]);

  const plan = useMemo(() => {
    if (!me) return null;
    return planSubscriptions({
      participants: state.participants.map((p) => ({ id: p.userId, hasVideo: Boolean(mediaById.get(p.userId)?.videoEnabled) })),
      activeSpeakers: media.snapshot.activeSpeakers,
      recentSpeakers: media.snapshot.recentSpeakers,
      layout,
      page,
      pinnedId,
      screenSharerId: state.presenterId,
      selfId: me.userId,
      config: PLAN_CONFIG,
    });
  }, [me, state.participants, state.presenterId, mediaById, media.snapshot.activeSpeakers, media.snapshot.recentSpeakers, layout, page, pinnedId]);

  const { applyPlan } = media;
  useEffect(() => {
    if (plan) applyPlan(plan);
  }, [plan, applyPlan]);

  // If the pinned person leaves, fall back to the normal layout.
  useEffect(() => {
    if (pinnedId && !appById.has(pinnedId)) setPinnedId(null);
  }, [pinnedId, appById]);

  const myHand = Boolean(me && appById.get(me.userId)?.handRaised);
  const sharing = Boolean(me && state.presenterId === me.userId);
  const mediaReady = media.snapshot.connection === 'connected';

  const toggleHand = useCallback(() => send('raise_hand', { raised: !myHand }), [send, myHand]);
  const toggleShare = useCallback(() => {
    if (sharing) {
      send('screen_share_stop');
      media.stopScreenShare();
    } else if (state.presenterId) {
      push(`${appById.get(state.presenterId)?.username || 'Someone'} is already presenting`);
    } else {
      send('screen_share_request');
    }
  }, [sharing, send, media, state.presenterId, appById, push]);
  const togglePanel = useCallback((name) => {
    setPanel((cur) => (cur === name ? null : name));
    if (name === 'chat') setUnread(0);
  }, []);
  const leave = useCallback(() => {
    send('leave_room');
    navigate('/');
  }, [send, navigate]);

  useKeyboardShortcuts({
    m: () => mediaReady && media.toggleMic(),
    v: () => mediaReady && media.toggleCamera(),
    s: () => mediaReady && toggleShare(),
    h: toggleHand,
    c: () => togglePanel('chat'),
    p: () => togglePanel('people'),
    g: () => setLayout((l) => (l === 'speaker' ? 'gallery' : 'speaker')),
  });

  function onAction(type, person, extra = {}, needsConfirm = false) {
    const run = () => send(type, { userId: person.userId, ...extra });
    if (!needsConfirm) return run();
    const copy = {
      remove_participant: { title: `Remove ${person.username}?`, body: 'They are disconnected and cannot rejoin this meeting.', confirmLabel: 'Remove', danger: true },
      transfer_host: { title: `Make ${person.username} the host?`, body: 'You become a participant. They get all host controls.', confirmLabel: 'Make host', danger: false },
    }[type];
    return setConfirm({ ...copy, run });
  }

  if (FATAL.has(state.status)) return <NoticeScreen kind={state.status} message={state.notice} />;
  if (!me || !plan) {
    return (
      <main className="notice"><div className="notice-card"><span className="spinner big" aria-label="Joining the meeting" /><h1>Joining the meeting</h1></div></main>
    );
  }

  const caps = meetingCapabilities(me.role);
  const connection = media.snapshot.connection;

  return (
    <div className={`meeting${panel ? ' with-panel' : ''}`}>
      <header className="meet-top">
        <div className="meet-left">
          <span className="brand"><span className="brand-mark" />Huddle</span>
          {meeting.title && <span className="meet-title">{meeting.title}</span>}
        </div>
        <div className="meet-center">
          <CodeTicket code={code} onCopied={push} />
        </div>
        <div className="meet-right">
          <StatusPills app={state.status} media={connection} />
          <span className="chip"><Icon name="people" size={13} />{state.count}/{state.capacity}</span>
          <MeetingTimer since={joinedAt.current} />
          {caps.canLock ? (
            <button type="button" className={`icon-btn${state.locked ? ' on' : ''}`} onClick={() => send(state.locked ? 'unlock_room' : 'lock_room')} aria-pressed={state.locked} aria-label={state.locked ? 'Unlock meeting' : 'Lock meeting'} data-tip={state.locked ? 'Unlock meeting' : 'Lock meeting'}>
              <Icon name={state.locked ? 'lock' : 'unlock'} size={18} />
            </button>
          ) : state.locked && <span className="chip chip-amber"><Icon name="lock" size={12} />Locked</span>}
        </div>
      </header>

      <main className="meet-main">
        {connection === 'failed' && (
          <div className="banner banner-bad" role="alert">
            <Icon name="alert" size={18} />
            <span>Your audio and video could not connect.</span>
            <button type="button" className="btn btn-small btn-primary" onClick={media.retry}>Retry</button>
            <button type="button" className="btn btn-small" onClick={leave}>Leave</button>
          </div>
        )}
        {!mediaReady && connection !== 'failed' && (
          <div className="banner" role="status"><span className="spinner small" aria-hidden="true" /><span>Connecting your audio and video...</span></div>
        )}
        {!media.snapshot.canPlayAudio && (
          <button type="button" className="enable-audio" onClick={media.startAudio}><Icon name="volume" size={18} />Click to enable audio</button>
        )}
        <MediaStage
          plan={plan}
          me={me}
          appById={appById}
          mediaById={mediaById}
          getTrack={media.getTrack}
          trackVersion={media.trackVersion}
          pinnedId={pinnedId}
          onPin={(id) => setPinnedId((cur) => (cur === id ? null : id))}
          page={page}
          onPage={setPage}
          onStopShare={toggleShare}
        />
      </main>

      <RemoteAudio getRemoteAudio={media.getRemoteAudio} trackVersion={media.trackVersion} />

      <ControlDock
        micOn={Boolean(media.local?.audioEnabled)}
        camOn={Boolean(media.local?.videoEnabled)}
        speaking={Boolean(media.local?.isSpeaking)}
        sharing={sharing}
        handUp={myHand}
        layout={plan.effectiveLayout}
        panel={panel}
        unreadChat={unread}
        peopleCount={state.count}
        isHost={caps.canEnd}
        viewerOnly={!mediaReady}
        onMic={media.toggleMic}
        onCamera={media.toggleCamera}
        onShare={toggleShare}
        onHand={toggleHand}
        onLayout={() => setLayout((l) => (l === 'speaker' ? 'gallery' : 'speaker'))}
        onPanel={togglePanel}
        onLeave={leave}
        onEndForAll={() => setConfirm({ title: 'End the meeting for everyone?', body: 'Everyone is disconnected right away and the meeting cannot be rejoined.', confirmLabel: 'End meeting', danger: true, run: () => send('end_meeting') })}
      />

      <SidePanel panel={panel} onClose={() => setPanel(null)} onTab={togglePanel} peopleCount={state.count} unreadChat={unread}>
        {panel === 'people' && (
          <PeoplePanel participants={state.participants} me={me} mediaById={mediaById} presenterId={state.presenterId} capacity={state.capacity} locked={state.locked} onAction={onAction} />
        )}
        {panel === 'chat' && <ChatPanel messages={state.chat} me={me} onSend={(message) => send('chat_message', { message })} />}
      </SidePanel>

      <Toasts toasts={toasts} onDismiss={dismiss} />
      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          body={confirm.body}
          confirmLabel={confirm.confirmLabel}
          danger={confirm.danger}
          onConfirm={() => { confirm.run(); setConfirm(null); }}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  );
}
