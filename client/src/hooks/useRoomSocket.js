import { useCallback, useEffect, useReducer, useRef } from 'react';
import { WS_URL } from '../services/config.js';
import { errorMessage, getWsTicket } from '../services/api.js';
import { backoffDelay, shouldReconnect } from '../meeting/backoff.js';
import { initialState, reducer } from '../meeting/meetingReducer.js';

const NOTICES = {
  4001: 'You were removed from this meeting.',
  4002: 'This meeting was opened in another tab.',
  4004: 'Meeting not found.',
  4005: 'The meeting has ended.',
};
const CLOSE_STATUS = { 4001: 'removed', 4002: 'replaced', 4004: 'notfound', 4005: 'ended' };

/**
 * Owns the single native WebSocket for a meeting: ticket, connect, join_room, messages, and
 * automatic reconnect with a FRESH ticket every time (tickets are single use).
 * It only carries app events (presence, chat, hands, moderation). Media is on the SFU.
 */
export function useRoomSocket(roomId, { onEvent } = {}) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const socketRef = useRef(null);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    let cancelled = false;
    let attempt = 0;
    let retryTimer = null;

    function scheduleRetry() {
      if (cancelled) return;
      attempt += 1;
      dispatch({ type: 'status', status: 'reconnecting' });
      retryTimer = setTimeout(connect, backoffDelay(attempt));
    }

    async function connect() {
      if (cancelled) return;
      let ticket;
      try {
        ticket = await getWsTicket(roomId); // a fresh single-use ticket for every (re)connect
      } catch (err) {
        const code = err.response?.status;
        if ([400, 403, 404, 410].includes(code)) {
          const status = { 403: 'removed', 404: 'notfound', 410: 'ended' }[code] || 'error';
          dispatch({ type: 'fatal', status, notice: errorMessage(err) });
          return;
        }
        scheduleRetry();
        return;
      }
      if (cancelled) return;

      const ws = new WebSocket(`${WS_URL}?ticket=${encodeURIComponent(ticket)}`);
      socketRef.current = ws;

      ws.onopen = () => ws.send(JSON.stringify({ type: 'join_room', payload: { roomId } }));
      ws.onmessage = (event) => {
        if (socketRef.current !== ws) return;
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        if (message.type === 'room_joined') attempt = 0;
        dispatch({ type: 'server', message });
        onEventRef.current?.(message);
      };
      ws.onclose = (event) => {
        if (socketRef.current === ws) socketRef.current = null;
        if (cancelled) return;
        if (!shouldReconnect(event.code)) {
          const status = CLOSE_STATUS[event.code];
          if (status) dispatch({ type: 'fatal', status, notice: NOTICES[event.code] });
          return;
        }
        scheduleRetry();
      };
    }

    connect();

    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
      const ws = socketRef.current;
      socketRef.current = null;
      ws?.close(1000);
    };
  }, [roomId]);

  const send = useCallback((type, payload = {}) => {
    const ws = socketRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type, payload }));
      return true;
    }
    onEventRef.current?.({ type: 'error', payload: { code: 'NOT_CONNECTED', message: 'Not connected. Reconnecting...' } });
    return false;
  }, []);

  return { state, send };
}
