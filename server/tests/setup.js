import { vi } from 'vitest';

// Every test file uses fakes instead of a real MongoDB connection.
vi.mock('../src/models/User.js', async () => ({ default: (await import('./helpers/fakeModels.js')).FakeUser }));
vi.mock('../src/models/Meeting.js', async () => ({ default: (await import('./helpers/fakeModels.js')).FakeMeeting }));
vi.mock('../src/models/MeetingMembership.js', async () => ({ default: (await import('./helpers/fakeModels.js')).FakeMembership }));
