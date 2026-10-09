const APP = { connected: ['live', 'Connected'], connecting: ['wait', 'Connecting'], reconnecting: ['wait', 'Reconnecting'] };
const MEDIA = {
  connected: ['live', 'Media connected'],
  connecting: ['wait', 'Media connecting'],
  reconnecting: ['wait', 'Media reconnecting'],
  waiting: ['wait', 'Media waiting'],
  failed: ['bad', 'Media failed'],
  idle: ['wait', 'Media starting'],
  ended: ['bad', 'Media stopped'],
};

export default function StatusPills({ app, media }) {
  const [appTone, appText] = APP[app] || ['wait', app];
  const [mediaTone, mediaText] = MEDIA[media] || ['wait', media];
  return (
    <div className="pills">
      <span className={`pill pill-${appTone}`}><i />{appText}</span>
      <span className={`pill pill-${mediaTone}`}><i />{mediaText}</span>
    </div>
  );
}
