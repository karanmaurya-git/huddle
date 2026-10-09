// In-memory stand-ins for the Mongoose models so tests run without a MongoDB server.
// They implement only the methods the services use. Fakes live in tests only.
let counter = 0;
const nextId = () => String(++counter).padStart(24, '0');
const users = new Map();
const meetings = new Map();
const memberships = new Map(); // `${userId}:${code}` -> row

/** Counts write operations so tests can prove which events touch the database. */
export const writes = { meeting: 0, membership: 0 };

const chain = (getResult) => {
  const c = {
    sort: () => c,
    limit: () => c,
    lean: () => c,
    then: (resolve, reject) => Promise.resolve(getResult()).then(resolve, reject),
  };
  return c;
};

export const FakeUser = {
  async create(data) {
    const doc = { _id: nextId(), ...data, createdAt: new Date() };
    users.set(doc._id, doc);
    return doc;
  },
  async findOne(query) {
    return [...users.values()].find((u) => u.email === query.email) || null;
  },
  async findById(id) {
    return users.get(String(id)) || null;
  },
};

export const FakeMeeting = {
  async create(data) {
    writes.meeting += 1;
    const doc = { _id: nextId(), title: '', status: 'active', locked: false, endedAt: null, createdAt: new Date(), ...data };
    meetings.set(doc.code, doc);
    return doc;
  },
  async findOne(query) {
    return meetings.get(query.code) || null;
  },
  find(query) {
    const codes = query.code?.$in || [];
    return chain(() => codes.map((c) => meetings.get(c)).filter(Boolean));
  },
  async updateOne(query, update) {
    writes.meeting += 1;
    const doc = meetings.get(query.code);
    if (doc) Object.assign(doc, update.$set);
    return { matchedCount: doc ? 1 : 0 };
  },
  async deleteOne(query) {
    writes.meeting += 1;
    return { deletedCount: meetings.delete(query.code) ? 1 : 0 };
  },
};

export const FakeMembership = {
  async updateOne(query, update, options = {}) {
    writes.membership += 1;
    const key = `${query.userId}:${query.meetingCode}`;
    const row = memberships.get(key);
    if (row) Object.assign(row, update.$set);
    else if (options.upsert) memberships.set(key, { userId: String(query.userId), meetingCode: query.meetingCode, ...update.$set });
    return {};
  },
  find(query) {
    return chain(() =>
      [...memberships.values()]
        .filter((m) => m.userId === String(query.userId))
        .sort((a, b) => b.lastJoinedAt - a.lastJoinedAt)
    );
  },
  async deleteMany(query) {
    for (const [key, row] of memberships) if (row.meetingCode === query.meetingCode) memberships.delete(key);
    return {};
  },
};

export const getFakeMeeting = (code) => meetings.get(code);
