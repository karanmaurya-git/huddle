import { useCallback, useEffect, useRef, useState } from 'react';
import { ConnectionState, DisconnectReason, Room, RoomEvent, Track, VideoPresets } from 'livekit-client';
import { getSfuToken } from '../services/api.js';
import { decideRecovery } from '../meeting/recovery.js';
import { applyDelay, plansEqual, shouldApplyPlan } from '../meeting/subscriptionPlanner.js';
import { mediaErrorMessage } from '../utils/format.js';

// A disconnect for these reasons is final: we were removed, replaced, or the room is gone.
const TERMINAL_REASONS = new Set([
  DisconnectReason.DUPLICATE_IDENTITY,
  DisconnectReason.PARTICIPANT_REMOVED,
  DisconnectReason.ROOM_DELETED,
  DisconnectReason.CLIENT_INITIATED,
]);

const EMPTY = {
  connection: 'idle', // idle | connecting | connected | reconnecting | waiting | failed | ended
  participants: [],
  activeSpeakers: [],
  recentSpeakers: [],
  canPlayAudio: true,
};

const infoOf = (p, isLocal) => ({
  id: p.identity,
  name: p.name || p.identity,
  isLocal,
  isSpeaking: p.isSpeaking,
  audioEnabled: p.isMicrophoneEnabled,
  videoEnabled: p.isCameraEnabled,
  screenEnabled: p.isScreenShareEnabled,
  quality: p.connectionQuality,
});

/**
 * Owns the media connection to the SFU (LiveKit). It publishes my mic/camera/screen, receives
 * only what the SubscriptionPlanner asks for, and reconnects with a FRESH token when needed.
 * Media streams live in refs, not React state, so video frames never cause re-renders.
 */
export function useLiveKitRoom({ code, enabled, appConnected, prefs, onNotice, onShareEnded }) {
  const [snapshot, setSnapshot] = useState(EMPTY);
  const [trackVersion, setTrackVersion] = useState(0);
  const [retryKey, setRetryKey] = useState(0); // bump to reconnect media without leaving the meeting
  const roomRef = useRef(null);
  const planRef = useRef(null);
  const appliedPlanRef = useRef(null);
  const lastAppliedRef = useRef(0);
  const applyTimerRef = useRef(null);
  const snapshotTimerRef = useRef(null);
  const activeRef = useRef({ active: [], recent: [] });
  const appConnectedRef = useRef(appConnected);
  const cb = useRef({ onNotice, onShareEnded, prefs });
  appConnectedRef.current = appConnected;
  cb.current = { onNotice, onShareEnded, prefs };

  const rebuild = useCallback((connection) => {
    const room = roomRef.current;
    if (!room) {
      if (connection) setSnapshot((prev) => ({ ...prev, connection }));
      return;
    }
    setSnapshot((prev) => ({
      connection: connection ?? prev.connection,
      participants: [infoOf(room.localParticipant, true), ...[...room.remoteParticipants.values()].map((p) => infoOf(p, false))],
      activeSpeakers: activeRef.current.active,
      recentSpeakers: activeRef.current.recent,
      canPlayAudio: room.canPlaybackAudio,
    }));
  }, []);

  const scheduleSnapshot = useCallback(() => {
    if (snapshotTimerRef.current) return;
    snapshotTimerRef.current = setTimeout(() => {
      snapshotTimerRef.current = null;
      rebuild();
    }, 150);
  }, [rebuild]);

  const bump = useCallback(() => {
    setTrackVersion((v) => v + 1);
    scheduleSnapshot();
  }, [scheduleSnapshot]);

  // ---------- subscriptions ----------

  const flushPlan = useCallback(() => {
    const room = roomRef.current;
    const plan = planRef.current;
    if (!room || !plan || room.state !== ConnectionState.Connected) return;
    for (const p of room.remoteParticipants.values()) {
      for (const pub of p.trackPublications.values()) {
        let want;
        if (pub.kind === Track.Kind.Video) {
          want = pub.source === Track.Source.ScreenShare ? plan.screen === p.identity : plan.video.has(p.identity);
        } else {
          want = pub.source === Track.Source.ScreenShareAudio ? plan.screen === p.identity : plan.audio.has(p.identity);
        }
        if (pub.isSubscribed !== want) pub.setSubscribed(want);
      }
    }
    appliedPlanRef.current = plan;
    lastAppliedRef.current = Date.now();
  }, []);

  const applyPlan = useCallback(
    (plan, { force = false } = {}) => {
      planRef.current = plan;
      const now = Date.now();
      if (force || shouldApplyPlan(appliedPlanRef.current, plan, now, lastAppliedRef.current)) {
        clearTimeout(applyTimerRef.current);
        applyTimerRef.current = null;
        flushPlan();
        return;
      }
      if (!plansEqual(appliedPlanRef.current, plan) && !applyTimerRef.current) {
        applyTimerRef.current = setTimeout(() => {
          applyTimerRef.current = null;
          flushPlan();
        }, applyDelay(now, lastAppliedRef.current));
      }
    },
    [flushPlan]
  );

  // ---------- connection lifecycle ----------

  useEffect(() => {
    if (!enabled || !code) return undefined;
    let disposed = false;
    let attempt = 0;
    let retryTimer = null;
    let warnedUnavailable = false;

    const notice = (text, kind = 'error') => cb.current.onNotice?.(text, kind);

    function scheduleRecovery(reason) {
      if (disposed) return;
      attempt += 1;
      const decision = decideRecovery({
        terminal: reason !== undefined && TERMINAL_REASONS.has(reason),
        attempt,
        appConnected: appConnectedRef.current,
      });
      if (decision.action === 'stop') {
        rebuild('ended');
      } else if (decision.action === 'give-up') {
        rebuild('failed');
        notice('Could not connect your audio and video. Press Retry when the media server is ready, or leave and rejoin.');
      } else if (decision.action === 'wait-for-app') {
        rebuild('waiting');
        retryTimer = setTimeout(() => scheduleRecovery(), 1500);
      } else {
        rebuild('reconnecting');
        retryTimer = setTimeout(connect, decision.delayMs);
      }
    }

    async function publishInitial(room) {
      const { prefs: p } = cb.current;
      if (p?.audio) {
        await room.localParticipant
          .setMicrophoneEnabled(true, p.audioDeviceId ? { deviceId: p.audioDeviceId } : undefined)
          .catch((err) => notice(mediaErrorMessage(err, 'microphone')));
      }
      if (p?.video) {
        await room.localParticipant
          .setCameraEnabled(true, p.videoDeviceId ? { deviceId: p.videoDeviceId } : undefined)
          .catch((err) => notice(mediaErrorMessage(err, 'camera')));
      }
    }

    async function connect() {
      if (disposed) return;
      rebuild('connecting');
      setSnapshot((s) => ({ ...s, connection: 'connecting' }));

      let info;
      try {
        info = await getSfuToken(code); // a FRESH token every time; the server checks we are a member
      } catch (err) {
        if (err.response?.status === 503 && !warnedUnavailable) {
          warnedUnavailable = true; // say it once, not on every retry
          notice(err.response.data?.message || 'The media server is unavailable right now.');
        }
        scheduleRecovery();
        return;
      }
      if (disposed) return;

      const room = new Room({
        adaptiveStream: true, // pick the video quality from the size of each tile
        dynacast: true, // stop sending video layers nobody is watching
        publishDefaults: { simulcast: true, videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360] },
        videoCaptureDefaults: { resolution: VideoPresets.h720.resolution },
        audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      roomRef.current = room;

      room
        .on(RoomEvent.ParticipantConnected, () => { rebuild(); flushPlan(); })
        .on(RoomEvent.ParticipantDisconnected, bump)
        .on(RoomEvent.TrackPublished, () => { scheduleSnapshot(); flushPlan(); })
        .on(RoomEvent.TrackUnpublished, bump)
        .on(RoomEvent.TrackSubscribed, bump)
        .on(RoomEvent.TrackUnsubscribed, bump)
        .on(RoomEvent.TrackMuted, bump)
        .on(RoomEvent.TrackUnmuted, bump)
        .on(RoomEvent.LocalTrackPublished, bump)
        .on(RoomEvent.LocalTrackUnpublished, (pub) => {
          bump();
          if (pub?.source === Track.Source.ScreenShare) cb.current.onShareEnded?.(); // browser "Stop sharing" or ours
        })
        .on(RoomEvent.ConnectionQualityChanged, scheduleSnapshot)
        .on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
          const ids = speakers.map((s) => s.identity);
          const recent = [...ids, ...activeRef.current.recent.filter((id) => !ids.includes(id))].slice(0, 30);
          activeRef.current = { active: ids, recent };
          scheduleSnapshot();
        })
        .on(RoomEvent.AudioPlaybackStatusChanged, () => rebuild())
        .on(RoomEvent.MediaDevicesError, (err) => notice(mediaErrorMessage(err)))
        .on(RoomEvent.Reconnecting, () => rebuild('reconnecting'))
        .on(RoomEvent.Reconnected, () => { rebuild('connected'); flushPlan(); })
        .on(RoomEvent.Disconnected, (reason) => {
          if (roomRef.current === room) scheduleRecovery(reason);
        });

      try {
        await room.connect(info.url, info.token, { autoSubscribe: false });
      } catch (err) {
        if (roomRef.current === room) roomRef.current = null;
        notice('Could not reach the media server.');
        scheduleRecovery();
        return;
      }
      if (disposed) {
        room.disconnect();
        return;
      }
      attempt = 0;
      rebuild('connected');
      flushPlan();
      await publishInitial(room);
      rebuild();
      setTrackVersion((v) => v + 1);
    }

    connect();

    return () => {
      disposed = true;
      clearTimeout(retryTimer);
      clearTimeout(applyTimerRef.current);
      clearTimeout(snapshotTimerRef.current);
      applyTimerRef.current = null;
      snapshotTimerRef.current = null;
      appliedPlanRef.current = null;
      const room = roomRef.current;
      roomRef.current = null;
      room?.disconnect(); // stops local tracks and frees the camera and microphone
      setSnapshot(EMPTY);
    };
  }, [code, enabled, retryKey, rebuild, bump, scheduleSnapshot, flushPlan]);

  // ---------- controls ----------

  const guard = useCallback(async (fn, kind) => {
    try {
      await fn();
    } catch (err) {
      cb.current.onNotice?.(mediaErrorMessage(err, kind), 'error');
    } finally {
      bump();
    }
  }, [bump]);

  const toggleMic = useCallback(() => {
    const lp = roomRef.current?.localParticipant;
    return lp ? guard(() => lp.setMicrophoneEnabled(!lp.isMicrophoneEnabled), 'microphone') : undefined;
  }, [guard]);

  const toggleCamera = useCallback(() => {
    const lp = roomRef.current?.localParticipant;
    return lp ? guard(() => lp.setCameraEnabled(!lp.isCameraEnabled), 'camera') : undefined;
  }, [guard]);

  const muteMic = useCallback(() => roomRef.current?.localParticipant.setMicrophoneEnabled(false).then(bump).catch(() => {}), [bump]);

  // The server must grant the presenter slot first; only then do we open the screen picker.
  const startScreenShare = useCallback(async () => {
    const lp = roomRef.current?.localParticipant;
    if (!lp) return;
    try {
      await lp.setScreenShareEnabled(true, { audio: true });
    } catch (err) {
      cb.current.onShareEnded?.();
      if (err?.name !== 'NotAllowedError') cb.current.onNotice?.(mediaErrorMessage(err, 'screen'), 'error');
    }
    bump();
  }, [bump]);

  const stopScreenShare = useCallback(async () => {
    await roomRef.current?.localParticipant.setScreenShareEnabled(false).catch(() => {});
    bump();
  }, [bump]);

  const startAudio = useCallback(() => roomRef.current?.startAudio().then(() => rebuild()).catch(() => {}), [rebuild]);

  const getTrack = useCallback((identity, source) => {
    const room = roomRef.current;
    if (!room) return null;
    const p = identity === room.localParticipant.identity ? room.localParticipant : room.remoteParticipants.get(identity);
    return p?.getTrackPublication(source)?.track ?? null;
  }, []);

  const getRemoteAudio = useCallback(() => {
    const room = roomRef.current;
    if (!room) return [];
    const out = [];
    for (const p of room.remoteParticipants.values()) {
      for (const pub of p.trackPublications.values()) {
        if (pub.kind === Track.Kind.Audio && pub.track) out.push({ sid: pub.trackSid, track: pub.track });
      }
    }
    return out;
  }, []);

  const retry = useCallback(() => setRetryKey((k) => k + 1), []);

  const local = snapshot.participants.find((p) => p.isLocal);

  return {
    snapshot,
    trackVersion,
    local,
    applyPlan,
    retry,
    toggleMic,
    toggleCamera,
    muteMic,
    startScreenShare,
    stopScreenShare,
    startAudio,
    getTrack,
    getRemoteAudio,
  };
}
