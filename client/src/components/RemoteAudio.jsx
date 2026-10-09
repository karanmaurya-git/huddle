import { useEffect, useRef } from 'react';

/** Plays the audio of every subscribed remote track through hidden <audio> elements. */
export default function RemoteAudio({ getRemoteAudio, trackVersion }) {
  const holder = useRef(null);
  const attached = useRef(new Map());

  useEffect(() => {
    const desired = new Map(getRemoteAudio().map(({ sid, track }) => [sid, track]));
    for (const [sid, entry] of attached.current) {
      if (!desired.has(sid)) {
        entry.track.detach(entry.el);
        entry.el.remove();
        attached.current.delete(sid);
      }
    }
    for (const [sid, track] of desired) {
      if (!attached.current.has(sid) && holder.current) {
        const el = track.attach();
        holder.current.appendChild(el);
        attached.current.set(sid, { track, el });
      }
    }
  }, [getRemoteAudio, trackVersion]);

  useEffect(() => {
    const map = attached.current;
    return () => {
      for (const { track, el } of map.values()) {
        track.detach(el);
        el.remove();
      }
      map.clear();
    };
  }, []);

  return <div ref={holder} hidden aria-hidden="true" />;
}
