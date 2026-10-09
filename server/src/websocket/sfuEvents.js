/**
 * Reconciles the app with what the SFU reports (webhooks). The app WebSocket stays the main
 * source of truth for presence; webhooks are a safety net, for example to free the presenter
 * slot when the screen-share track disappears without the app being told.
 * Every branch is idempotent, because webhooks can be delivered more than once.
 */
export function handleSfuEvent({ roomManager }, event) {
  const room = event.room ? roomManager.getRoom(event.room) : null;
  if (!room || !event.identity) return;

  if (event.type === 'track_unpublished' && event.trackSource === 'SCREEN_SHARE') {
    room.releasePresenter(event.identity, 'track_unpublished');
  }
  if (event.type === 'participant_left') {
    room.releasePresenter(event.identity, 'sfu_participant_left');
  }
}
