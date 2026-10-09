import { Track } from 'livekit-client';
import Icon from './Icons.jsx';
import VideoTile from './VideoTile.jsx';

const gridColumns = (count) => Math.min(4, Math.max(1, Math.ceil(Math.sqrt(count))));

/** Speaker view (stage plus a strip) or paginated gallery. Only what the plan lists is rendered. */
export default function MediaStage({ plan, me, appById, mediaById, getTrack, trackVersion, pinnedId, onPin, page, onPage, onStopShare }) {
  const infoFor = (id) => mediaById.get(id) || { id, name: appById.get(id)?.username || '...', isLocal: id === me.userId, videoEnabled: false, audioEnabled: false, screenEnabled: false };
  const handOf = (id) => Boolean(appById.get(id)?.handRaised);
  const roleOf = (id) => appById.get(id)?.role;
  const common = { getTrack, trackVersion };

  if (plan.effectiveLayout === 'gallery') {
    return (
      <div className="gallery-wrap">
        <div className="gallery" style={{ '--cols': gridColumns(plan.pageIds.length) }}>
          {plan.pageIds.map((id) => (
            <VideoTile key={id} info={infoFor(id)} role={roleOf(id)} handRaised={handOf(id)} onPin={onPin} pinned={pinnedId === id} mirrored={id === me.userId} {...common} />
          ))}
        </div>
        {plan.pageCount > 1 && (
          <div className="pager" role="group" aria-label="Pages">
            <button type="button" className="icon-btn" onClick={() => onPage(plan.page - 1)} disabled={plan.page === 0} aria-label="Previous page"><Icon name="left" /></button>
            <span>Page {plan.page + 1} of {plan.pageCount}</span>
            <button type="button" className="icon-btn" onClick={() => onPage(plan.page + 1)} disabled={plan.page >= plan.pageCount - 1} aria-label="Next page"><Icon name="right" /></button>
          </div>
        )}
      </div>
    );
  }

  const stageIsMe = plan.stageId === me.userId;
  const alone = !plan.stageId;
  return (
    <div className="speaker-layout">
      <div className="stage">
        {alone && (
          <div className="stage-empty">
            <h2>You are the first one here</h2>
            <p className="muted">Share the code from the top bar. People show up here as they join.</p>
          </div>
        )}
        {!alone && plan.stageKind === 'screen' && stageIsMe && (
          <div className="stage-empty sharing-self">
            <Icon name="screen" size={36} />
            <h2>You are sharing your screen</h2>
            <button type="button" className="btn btn-danger-solid" onClick={onStopShare}>Stop sharing</button>
          </div>
        )}
        {!alone && plan.stageKind === 'screen' && !stageIsMe && (
          <VideoTile info={infoFor(plan.stageId)} source={Track.Source.ScreenShare} size="stage" label={`${infoFor(plan.stageId).name}'s screen`} {...common} />
        )}
        {!alone && plan.stageKind === 'camera' && (
          <VideoTile info={infoFor(plan.stageId)} role={roleOf(plan.stageId)} handRaised={handOf(plan.stageId)} size="stage" onPin={onPin} pinned={pinnedId === plan.stageId} mirrored={stageIsMe} {...common} />
        )}
      </div>
      {plan.stripIds.length > 0 && (
        <div className="strip">
          {plan.stripIds.map((id) => (
            <VideoTile key={id} info={infoFor(id)} role={roleOf(id)} handRaised={handOf(id)} size="strip" onPin={onPin} pinned={pinnedId === id} {...common} />
          ))}
        </div>
      )}
      <div className="self-view">
        <VideoTile info={infoFor(me.userId)} role={roleOf(me.userId)} handRaised={handOf(me.userId)} size="self" mirrored {...common} />
      </div>
    </div>
  );
}
