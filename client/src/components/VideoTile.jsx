import { memo, useEffect, useRef } from 'react';
import { Track } from 'livekit-client';
import Icon from './Icons.jsx';
import { hueFor, initials } from '../utils/format.js';

const QUALITY_LABEL = { excellent: 'Excellent connection', good: 'Good connection', poor: 'Poor connection', lost: 'Connection lost' };

/**
 * One person (camera) or one screen share. The <video> element is attached to the SDK track
 * directly, so frames never pass through React state.
 */
function VideoTile({ info, role, handRaised, source = Track.Source.Camera, getTrack, trackVersion, pinned, onPin, size = 'tile', mirrored = false, label }) {
  const videoRef = useRef(null);
  const isScreen = source === Track.Source.ScreenShare;
  const wantsVideo = isScreen ? info.screenEnabled || true : info.videoEnabled;

  useEffect(() => {
    const el = videoRef.current;
    const track = wantsVideo ? getTrack(info.id, source) : null;
    if (!el || !track) return undefined;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [getTrack, info.id, source, wantsVideo, trackVersion]);

  const hasTrack = Boolean(wantsVideo && getTrack(info.id, source));
  const name = label || (info.isLocal ? `${info.name} (you)` : info.name);

  return (
    <div
      className={`tile tile-${size}${info.isSpeaking && !isScreen ? ' speaking' : ''}${isScreen ? ' tile-screen' : ''}`}
      style={{ '--hue': hueFor(info.name) }}
    >
      <video ref={videoRef} className={`tile-video${mirrored && !isScreen ? ' mirrored' : ''}${hasTrack ? '' : ' hidden'}`} autoPlay playsInline muted />
      {!hasTrack && (
        <div className="tile-avatar" aria-hidden="true">
          <span>{initials(info.name)}</span>
        </div>
      )}

      <div className="tile-top">
        {handRaised && (
          <span className="tile-hand" title="Hand raised">
            <Icon name="hand" size={16} />
          </span>
        )}
        {onPin && (
          <button type="button" className={`tile-pin${pinned ? ' on' : ''}`} onClick={() => onPin(info.id)} aria-label={pinned ? 'Unpin' : 'Pin to stage'} aria-pressed={pinned}>
            <Icon name="pin" size={15} />
          </button>
        )}
      </div>

      <div className="tile-bottom">
        <span className="tile-name">
          {!isScreen && !info.audioEnabled && <Icon name="micOff" size={14} className="tile-muted" />}
          {role && !isScreen && <span className={`tile-role tile-role-${role}`} title={role}><Icon name={role === 'host' ? 'crown' : 'shield'} size={12} /></span>}
          <span className="tile-name-text">{name}</span>
        </span>
        {!isScreen && !info.isLocal && (
          <span className={`quality quality-${info.quality || 'unknown'}`} title={QUALITY_LABEL[info.quality] || 'Connection unknown'}>
            <Icon name="signal" size={14} />
          </span>
        )}
      </div>
    </div>
  );
}

export default memo(VideoTile);
