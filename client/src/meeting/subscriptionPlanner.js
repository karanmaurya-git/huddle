// Decides WHO we receive media from, so a 100-person meeting never pulls 100 videos.
// Pure function: no React, no SDK. The meeting hook feeds it the current state and then
// applies the result with `publication.setSubscribed(...)`.

export const DEFAULT_PLAN_CONFIG = Object.freeze({
  pageSize: 12, // tiles per gallery page
  stripSize: 8, // small tiles next to the stage in speaker view
  audioAllLimit: 25, // up to this many people, listen to everyone
  audioTopN: 10, // above it, listen only to the most relevant N
});

const uniq = (list) => [...new Set(list.filter(Boolean))];

export function paginate(ids, page, pageSize) {
  const pageCount = Math.max(1, Math.ceil(ids.length / pageSize));
  const safePage = Math.min(Math.max(0, page), pageCount - 1);
  return { pageIds: ids.slice(safePage * pageSize, (safePage + 1) * pageSize), page: safePage, pageCount };
}

/**
 * participants: [{ id, hasVideo }] in display order (include yourself, flagged by `selfId`)
 * activeSpeakers: ids speaking right now (loudest first). recentSpeakers: ids by last time spoken.
 * layout: 'speaker' | 'gallery'. A screen share or a pinned person always forces 'speaker'.
 */
export function planSubscriptions({
  participants,
  activeSpeakers = [],
  recentSpeakers = [],
  layout = 'speaker',
  page = 0,
  pinnedId = null,
  screenSharerId = null,
  selfId = null,
  config = {},
}) {
  const cfg = { ...DEFAULT_PLAN_CONFIG, ...config };
  const byId = new Map(participants.map((p) => [p.id, p]));
  const remote = participants.filter((p) => p.id !== selfId);
  const remoteIds = new Set(remote.map((p) => p.id));

  const sharer = screenSharerId && byId.has(screenSharerId) ? screenSharerId : null;
  const pinned = pinnedId && byId.has(pinnedId) ? pinnedId : null;
  const effectiveLayout = sharer || pinned ? 'speaker' : layout;
  const speakerOrder = uniq([...activeSpeakers, ...recentSpeakers]).filter((id) => remoteIds.has(id));

  let stageId = null;
  let stageKind = 'camera';
  let stripIds = [];
  let pageIds = [];
  let pageInfo = { page: 0, pageCount: 1 };
  const video = new Set();

  if (effectiveLayout === 'gallery') {
    const result = paginate(participants.map((p) => p.id), page, cfg.pageSize);
    pageIds = result.pageIds;
    pageInfo = { page: result.page, pageCount: result.pageCount };
    for (const id of pageIds) if (id !== selfId && byId.get(id).hasVideo) video.add(id);
  } else {
    stageKind = sharer ? 'screen' : 'camera';
    stageId =
      sharer ??
      pinned ??
      speakerOrder[0] ??
      remote.find((p) => p.hasVideo)?.id ??
      remote[0]?.id ??
      null;

    // Strip: recent speakers first (most recent first), then people with cameras, then the rest.
    const rank = (p) => {
      const i = speakerOrder.indexOf(p.id);
      return [i === -1 ? 1 : 0, i === -1 ? 0 : i, p.hasVideo ? 0 : 1];
    };
    const candidates = remote.filter((p) => stageKind === 'screen' || p.id !== stageId);
    stripIds = [...candidates]
      .sort((a, b) => {
        const [a0, a1, a2] = rank(a);
        const [b0, b1, b2] = rank(b);
        return a0 - b0 || a1 - b1 || a2 - b2;
      })
      .slice(0, cfg.stripSize)
      .map((p) => p.id);

    for (const id of stripIds) if (byId.get(id).hasVideo) video.add(id);
    if (stageKind === 'camera' && stageId && stageId !== selfId && byId.get(stageId).hasVideo) video.add(stageId);
  }

  let audio;
  if (participants.length <= cfg.audioAllLimit) {
    audio = new Set(remote.map((p) => p.id));
  } else {
    const priority = uniq([pinned, sharer, stageId, ...speakerOrder]).filter((id) => remoteIds.has(id));
    audio = new Set(priority.slice(0, cfg.audioTopN));
  }

  return {
    effectiveLayout,
    stageId,
    stageKind,
    stripIds,
    pageIds,
    ...pageInfo,
    video,
    audio,
    screen: sharer && sharer !== selfId ? sharer : null,
  };
}

const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

export const plansEqual = (a, b) =>
  Boolean(a) && Boolean(b) && sameSet(a.video, b.video) && sameSet(a.audio, b.audio) && a.screen === b.screen;

/**
 * Subscription changes are throttled so a quickly changing "who is speaking" does not make us
 * subscribe and unsubscribe all the time. A screen share change is applied immediately.
 */
export function shouldApplyPlan(prev, next, now, lastAppliedAt, minIntervalMs = 400) {
  if (!prev) return true;
  if (plansEqual(prev, next)) return false;
  if (prev.screen !== next.screen) return true;
  return now - lastAppliedAt >= minIntervalMs;
}

export const applyDelay = (now, lastAppliedAt, minIntervalMs = 400) => Math.max(0, minIntervalMs - (now - lastAppliedAt));
