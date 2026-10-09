export const initials = (name = '') =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || '')
    .join('') || '?';

// A stable hue per person, so the same name always gets the same avatar color.
export function hueFor(name = '') {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) % 360;
  return hash;
}

export function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

export function timeAgo(date, now = Date.now()) {
  const seconds = Math.max(0, Math.round((now - new Date(date).getTime()) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

export const ROLE_LABEL = { host: 'Host', moderator: 'Moderator', participant: 'Participant' };

/** Turns a getUserMedia / SDK failure into something a person can act on. */
export function mediaErrorMessage(error, kind = 'camera or microphone') {
  const name = error?.name || '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return `Access to your ${kind} was blocked. Allow it in the browser address bar and try again.`;
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return `No ${kind} was found on this device.`;
  if (name === 'NotReadableError' || name === 'TrackStartError') return `Your ${kind} is being used by another app.`;
  if (name === 'OverconstrainedError') return 'The selected device is not available any more. Pick another one.';
  if (typeof window !== 'undefined' && window.isSecureContext === false) {
    return 'Camera and microphone only work on HTTPS or localhost.';
  }
  return error?.message || `Could not start your ${kind}.`;
}
