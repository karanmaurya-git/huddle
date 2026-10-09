import http from 'node:http';
import WebSocket from 'ws';
import { createApp } from '../../src/app.js';
import { TicketService } from '../../src/services/ticketService.js';
import { createMeetingLifecycle } from '../../src/services/meetingLifecycle.js';
import * as meetingService from '../../src/services/meetingService.js';
import { RoomManager } from '../../src/websocket/RoomManager.js';
import { setupWebSocket } from '../../src/websocket/index.js';
import { FakeSfu } from './fakeSfu.js';

let userCounter = 0;

/** Starts the real Express + ws stack on a random port. Timers are shortened for tests. */
export async function startTestServer({ options = {}, sfu = new FakeSfu(), maxParticipants = 100 } = {}) {
  const ticketService = new TicketService();
  const roomManager = new RoomManager({ options: { disconnectGraceMs: 300, emptyRoomMs: 400, ...options }, sfu, maxParticipants });
  const lifecycle = createMeetingLifecycle({ roomManager, sfu });
  const server = http.createServer(createApp({ roomManager, ticketService, sfu, lifecycle }));
  const wss = setupWebSocket({ server, roomManager, ticketService, sfu, lifecycle, persistence: meetingService });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  return {
    port,
    baseUrl: `http://localhost:${port}`,
    wsUrl: `ws://localhost:${port}`,
    roomManager,
    ticketService,
    sfu,
    async close() {
      for (const client of wss.clients) client.terminate();
      roomManager.shutdown();
      ticketService.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export async function api(baseUrl, path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

export async function registerUser(baseUrl, name) {
  userCounter += 1;
  const { body } = await api(baseUrl, '/auth/register', {
    method: 'POST',
    body: { name, email: `user${userCounter}-${Date.now()}@test.dev`, password: 'password123' },
  });
  if (!body.token) throw new Error(`registerUser failed for "${name}": ${body.message}`);
  return { token: body.token, user: body.user };
}

export const createMeeting = async (baseUrl, token) =>
  (await api(baseUrl, '/meetings', { method: 'POST', token, body: {} })).body.meeting.code;

export const getTicket = async (baseUrl, token, roomId) =>
  (await api(baseUrl, '/auth/ws-ticket', { method: 'POST', token, body: { roomId } })).body.ticket;

/** Minimal real WebSocket client that records every message. */
export class TestClient {
  constructor(wsUrl, ticket, headers = {}) {
    this.messages = [];
    this.waiters = [];
    this.ws = new WebSocket(`${wsUrl}?ticket=${ticket}`, { headers });
    this.opened = new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
      this.ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    });
    this.closed = new Promise((resolve) => this.ws.once('close', (code) => resolve(code)));
    this.ws.on('message', (data) => {
      const message = JSON.parse(data.toString());
      this.messages.push(message);
      this.waiters = this.waiters.filter((w) => !w.try(message));
    });
  }

  send(type, payload = {}) {
    this.ws.send(JSON.stringify({ type, payload }));
  }

  sendRaw(text) {
    this.ws.send(text);
  }

  /** Resolves with the next (or an already received, unconsumed) message of this type. */
  waitFor(type, predicate = () => true, timeout = 2000) {
    const existing = this.messages.find((m) => m.type === type && predicate(m.payload) && !m.consumed);
    if (existing) {
      existing.consumed = true;
      return Promise.resolve(existing.payload);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for "${type}"`)), timeout);
      this.waiters.push({
        try: (m) => {
          if (m.type !== type || !predicate(m.payload)) return false;
          m.consumed = true;
          clearTimeout(timer);
          resolve(m.payload);
          return true;
        },
      });
    });
  }

  /** Returns the messages of this type that arrive within `ms` (expected to be none). */
  async expectNone(type, ms = 150) {
    const start = this.messages.length;
    await new Promise((r) => setTimeout(r, ms));
    return this.messages.slice(start).filter((m) => m.type === type);
  }

  close() {
    this.ws.close();
  }
}

/** Registers (or reuses) a user, gets a ticket, connects and joins. Resolves on room_joined. */
export async function joinAs(srv, name, roomId, token) {
  const auth = token ? { token } : await registerUser(srv.baseUrl, name);
  const ticket = await getTicket(srv.baseUrl, auth.token, roomId);
  const client = new TestClient(srv.wsUrl, ticket);
  await client.opened;
  client.send('join_room', { roomId });
  const joined = await client.waitFor('room_joined');
  return { client, joined, auth };
}

/** A Host who created a meeting and a Participant who joined it. */
export async function hostAndParticipant(srv) {
  const host = await registerUser(srv.baseUrl, 'Host');
  const roomId = await createMeeting(srv.baseUrl, host.token);
  const a = await joinAs(srv, 'Host', roomId, host.token);
  const b = await joinAs(srv, 'Bob', roomId);
  return { roomId, host: a, bob: b };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
