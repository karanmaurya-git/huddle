// What the UI SHOWS for each role. The server enforces the same rules; hiding buttons is
// only convenience. Keep this in sync with server/src/websocket/constants.js (canModerate).

export const isPrivileged = (role) => role === 'host' || role === 'moderator';

/** Mirrors the server: Host acts on anyone but self; a Moderator only on Participants. */
export function canActOn(actor, target) {
  if (!actor || !target || actor.userId === target.userId) return false;
  if (actor.role === 'host') return true;
  return actor.role === 'moderator' && target.role === 'participant';
}

export function meetingCapabilities(role) {
  return {
    canLock: role === 'host',
    canEnd: role === 'host',
    canAssignRoles: role === 'host',
    canTransferHost: role === 'host',
  };
}

/** The buttons to offer `actor` for one person in the People list. */
export function personActions(actor, target, { isSharing = false } = {}) {
  const allowed = canActOn(actor, target);
  const host = actor?.role === 'host' && allowed;
  return {
    mute: allowed,
    lowerHand: allowed && Boolean(target?.handRaised),
    stopShare: allowed && isSharing,
    remove: allowed,
    makeModerator: host && target.role === 'participant',
    makeParticipant: host && target.role === 'moderator',
    makeHost: host,
  };
}
