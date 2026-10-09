import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

vi.mock('../src/services/api.js', () => ({
  STORAGE_KEY: 'huddle-auth',
  readSession: vi.fn(() => ({ token: 't', user: { id: 'u1', name: 'Karan Maurya', email: 'k@x.dev' } })),
  login: vi.fn(),
  register: vi.fn(),
  logout: vi.fn(() => Promise.resolve()),
  createMeeting: vi.fn(),
  listMeetings: vi.fn(),
  getMeeting: vi.fn(),
  deleteMeeting: vi.fn(),
  errorMessage: (e) => e.response?.data?.message || e.message,
  getWsTicket: vi.fn(),
  getSfuToken: vi.fn(),
  default: {},
}));

import * as api from '../src/services/api.js';
import { AuthProvider } from '../src/context/AuthContext.jsx';
import AuthForm from '../src/pages/AuthForm.jsx';
import Dashboard from '../src/pages/Dashboard.jsx';
import Lobby from '../src/pages/Lobby.jsx';
import PeoplePanel from '../src/components/PeoplePanel.jsx';
import ControlDock from '../src/components/ControlDock.jsx';
import ChatPanel from '../src/components/ChatPanel.jsx';
import NoticeScreen from '../src/components/NoticeScreen.jsx';

const shell = (ui, path = '/') => (
  <MemoryRouter initialEntries={[path]}>
    <AuthProvider>
      <Routes>
        <Route path="/" element={ui} />
        <Route path="/login" element={ui} />
        <Route path="/register" element={ui} />
        <Route path="/meeting/:code" element={<p>meeting page</p>} />
      </Routes>
    </AuthProvider>
  </MemoryRouter>
);

beforeEach(() => vi.clearAllMocks());

describe('login and register', () => {
  it('logs in, and shows the server error when it fails', async () => {
    api.login.mockRejectedValueOnce({ response: { data: { message: 'Invalid email or password' } } });
    render(shell(<AuthForm mode="login" />, '/login'));
    fireEvent.change(screen.getByPlaceholderText('you@example.com'), { target: { value: 'a@b.co' } });
    fireEvent.change(screen.getByPlaceholderText('Your password'), { target: { value: 'wrong-pass' } });
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password');
    expect(api.login).toHaveBeenCalledWith({ email: 'a@b.co', password: 'wrong-pass' });

    api.login.mockResolvedValueOnce({ token: 'tok', user: { id: '1', name: 'A', email: 'a@b.co' } });
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));
    await waitFor(() => expect(localStorage.getItem('huddle-auth')).toContain('tok'));
  });

  it('register asks for a name and can show the password', () => {
    render(shell(<AuthForm mode="register" />, '/register'));
    expect(screen.getByPlaceholderText('Your name')).toBeInTheDocument();
    const password = screen.getByPlaceholderText('At least 8 characters');
    expect(password).toHaveAttribute('type', 'password');
    fireEvent.click(screen.getByRole('button', { name: 'Show password' }));
    expect(password).toHaveAttribute('type', 'text');
  });
});

describe('dashboard', () => {
  const meetings = [
    { code: 'AAA222', title: 'Standup', status: 'active', locked: false, isHost: true, live: 3, lastJoinedAt: new Date().toISOString() },
    { code: 'BBB333', title: '', status: 'ended', locked: false, isHost: false, live: 0, lastJoinedAt: new Date().toISOString() },
  ];

  it('lists recent meetings, with Delete only for meetings you host and Join disabled when ended', async () => {
    api.listMeetings.mockResolvedValue(meetings);
    render(shell(<Dashboard />));
    expect(await screen.findByText('Standup')).toBeInTheDocument();
    expect(screen.getByText('Live, 3 in the room')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete meeting AAA222' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete meeting BBB333' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Ended' })).toBeDisabled();
  });

  it('shows an empty state when there are no meetings', async () => {
    api.listMeetings.mockResolvedValue([]);
    render(shell(<Dashboard />));
    expect(await screen.findByText('No meetings yet')).toBeInTheDocument();
  });

  it('asks for confirmation before deleting, then deletes and removes the card', async () => {
    api.listMeetings.mockResolvedValue(meetings);
    api.deleteMeeting.mockResolvedValue({ success: true });
    render(shell(<Dashboard />));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete meeting AAA222' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Delete meeting AAA222?');
    expect(api.deleteMeeting).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete meeting' }));
    await waitFor(() => expect(api.deleteMeeting).toHaveBeenCalledWith('AAA222'));
    await waitFor(() => expect(screen.queryByText('Standup')).toBeNull());
  });

  it('only enables Join with a full 6-character code, and rejects unknown codes', async () => {
    api.listMeetings.mockResolvedValue([]);
    api.getMeeting.mockRejectedValue({ response: { status: 404 } });
    render(shell(<Dashboard />));
    const input = screen.getByLabelText('Meeting code');
    const join = screen.getByRole('button', { name: 'Join meeting' });
    fireEvent.change(input, { target: { value: 'abc' } });
    expect(join).toBeDisabled();
    fireEvent.change(input, { target: { value: 'ab-c23!4' } });
    expect(input.value).toBe('ABC234'); // uppercased, symbols stripped, capped at 6
    expect(join).toBeEnabled();
    fireEvent.click(join);
    expect(await screen.findByText('No meeting has that code. Check it and try again.')).toBeInTheDocument();
  });

  it('creates a meeting and opens it', async () => {
    api.listMeetings.mockResolvedValue([]);
    api.createMeeting.mockResolvedValue({ code: 'NEW234' });
    render(shell(<Dashboard />));
    fireEvent.change(screen.getByPlaceholderText('Weekly sync'), { target: { value: 'Planning' } });
    fireEvent.click(screen.getByRole('button', { name: 'New meeting' }));
    await waitFor(() => expect(api.createMeeting).toHaveBeenCalledWith('Planning'));
    expect(await screen.findByText('meeting page')).toBeInTheDocument();
  });
});

describe('lobby', () => {
  const meeting = { code: 'ABC234', title: 'Sync', count: 2, capacity: 100, locked: false, isHost: false, status: 'active' };
  const renderLobby = (m = meeting, onJoin = vi.fn()) => render(<MemoryRouter><Lobby meeting={m} onJoin={onJoin} /></MemoryRouter>);

  it('lets you join without camera and microphone when the browser has no media access', () => {
    Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
    const onJoin = vi.fn();
    renderLobby(meeting, onJoin);
    expect(screen.getByRole('alert')).toHaveTextContent(/HTTPS or localhost/);
    fireEvent.click(screen.getByRole('button', { name: 'Join meeting' }));
    expect(onJoin).toHaveBeenCalledWith({ audio: false, video: false, audioDeviceId: undefined, videoDeviceId: undefined });
  });

  it('explains a blocked camera and microphone and still allows joining', async () => {
    const denied = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: vi.fn().mockRejectedValue(denied), enumerateDevices: vi.fn().mockResolvedValue([]) },
      configurable: true,
    });
    const onJoin = vi.fn();
    renderLobby(meeting, onJoin);
    expect(await screen.findAllByText(/was blocked/)).not.toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Join meeting' }));
    expect(onJoin).toHaveBeenCalledWith(expect.objectContaining({ audio: false, video: false }));
  });

  it('blocks joining a locked meeting (unless you are the host) and a full meeting', () => {
    Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
    const { unmount } = renderLobby({ ...meeting, locked: true });
    expect(screen.getByRole('button', { name: 'Join meeting' })).toBeDisabled();
    unmount();
    const second = renderLobby({ ...meeting, locked: true, isHost: true });
    expect(screen.getByRole('button', { name: 'Join meeting' })).toBeEnabled();
    second.unmount();
    renderLobby({ ...meeting, count: 100 });
    expect(screen.getByRole('button', { name: 'Join meeting' })).toBeDisabled();
  });
});

describe('people panel', () => {
  const make = (n) => Array.from({ length: n }, (_, i) => ({
    userId: `u${i}`, username: `Person ${i}`, role: i === 0 ? 'host' : i === 1 ? 'moderator' : 'participant',
    handRaised: i === 5, handRaisedAt: i === 5 ? 100 : null, joinedAt: i,
  }));
  const panel = (people, me, onAction = vi.fn()) =>
    render(<PeoplePanel participants={people} me={me} mediaById={new Map()} presenterId={null} capacity={100} locked={false} onAction={onAction} />);

  it('renders only the visible rows for 100 people (windowed list)', () => {
    panel(make(100), make(100)[0]);
    const rows = screen.getAllByRole('button', { name: /Person \d+, / });
    expect(rows.length).toBeGreaterThan(5);
    expect(rows.length).toBeLessThan(25);
  });

  it('puts raised hands first with their queue number', () => {
    panel(make(10), make(10)[0]);
    const first = screen.getAllByRole('button', { name: /Person \d+, / })[0];
    expect(first).toHaveAccessibleName('Person 5, participant');
    expect(screen.getByTitle('Hand raised, number 1')).toBeInTheDocument();
  });

  it('offers the Host every action, a Moderator only Participant actions, a Participant none', () => {
    const people = make(10);
    const onAction = vi.fn();
    const { unmount } = panel(people, people[0], onAction); // host
    fireEvent.click(screen.getByRole('button', { name: 'Person 2, participant' }));
    for (const label of ['Mute', 'Make moderator', 'Make host', 'Remove']) expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Mute' }));
    expect(onAction).toHaveBeenCalledWith('mute_participant', expect.objectContaining({ userId: 'u2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(onAction).toHaveBeenCalledWith('remove_participant', expect.objectContaining({ userId: 'u2' }), {}, true);
    unmount();

    const mod = panel(people, people[1]); // moderator
    fireEvent.click(screen.getByRole('button', { name: 'Person 2, participant' }));
    expect(screen.getByRole('button', { name: 'Mute' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Make moderator' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Make host' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Person 0, host' }));
    expect(screen.getByText('You have no actions for this person.')).toBeInTheDocument();
    mod.unmount();

    panel(people, people[3]); // participant
    fireEvent.click(screen.getByRole('button', { name: 'Person 2, participant' }));
    expect(screen.getByText('You have no actions for this person.')).toBeInTheDocument();
  });
});

describe('control dock', () => {
  const dock = (props = {}) => {
    const handlers = { onMic: vi.fn(), onCamera: vi.fn(), onShare: vi.fn(), onHand: vi.fn(), onLayout: vi.fn(), onPanel: vi.fn(), onLeave: vi.fn(), onEndForAll: vi.fn() };
    render(<ControlDock micOn camOn speaking={false} sharing={false} handUp={false} layout="speaker" panel={null} unreadChat={0} peopleCount={3} isHost={false} viewerOnly={false} {...handlers} {...props} />);
    return handlers;
  };

  it('disables mic, camera and share until the media connection is ready, but not the hand', () => {
    const h = dock({ viewerOnly: true });
    expect(screen.getByRole('button', { name: 'Mute' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Turn camera off' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Share screen' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Raise hand' }));
    expect(h.onHand).toHaveBeenCalled();
  });

  it('shows real state: muted mic, raised hand, unread chat badge', () => {
    dock({ micOn: false, handUp: true, unreadChat: 12 });
    expect(screen.getByRole('button', { name: 'Unmute' })).toHaveAttribute('data-tip', 'Unmute (M)');
    expect(screen.getByRole('button', { name: 'Lower hand' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('9+')).toBeInTheDocument();
  });

  it('a Participant leaves directly; the Host gets a menu with End for everyone', () => {
    const p = dock();
    fireEvent.click(screen.getByRole('button', { name: 'Leave meeting' }));
    expect(p.onLeave).toHaveBeenCalledTimes(1);
  });

  it('Host menu: leave or end the meeting for everyone', () => {
    const h = dock({ isHost: true });
    fireEvent.click(screen.getByRole('button', { name: 'Leave meeting' }));
    expect(h.onLeave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('menuitem', { name: /End for everyone/ }));
    expect(h.onEndForAll).toHaveBeenCalledTimes(1);
  });
});

describe('chat panel', () => {
  it('shows messages as plain text (no HTML injection) and sends trimmed text', () => {
    const onSend = vi.fn(() => true);
    const messages = [{ id: '1', userId: 'x', username: 'Eve', message: '<img src=x onerror=alert(1)>', timestamp: Date.now() }];
    const { container } = render(<ChatPanel messages={messages} me={{ userId: 'me' }} onSend={onSend} />);
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
    const input = screen.getByLabelText('Message');
    fireEvent.change(input, { target: { value: '  hello  ' } });
    fireEvent.submit(input.closest('form'));
    expect(onSend).toHaveBeenCalledWith('hello');
    expect(input.value).toBe('');
  });
});

describe('notice screens', () => {
  it.each([
    ['removed', 'You were removed from this meeting'],
    ['ended', 'This meeting has ended'],
    ['full', 'This meeting is full'],
    ['locked', 'The host locked this meeting'],
    ['notfound', 'Meeting not found'],
  ])('shows a clear screen for %s', (kind, title) => {
    render(<MemoryRouter><NoticeScreen kind={kind} /></MemoryRouter>);
    expect(screen.getByRole('heading', { name: title })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to dashboard' })).toHaveAttribute('href', '/');
  });
});
