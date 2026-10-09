import { useEffect, useRef, useState } from 'react';

/** Live microphone level (0 to 1) for a MediaStream, used by the lobby level meter. */
export function useAudioLevel(stream) {
  const [level, setLevel] = useState(0);
  const frame = useRef(0);

  useEffect(() => {
    if (!stream || stream.getAudioTracks().length === 0) {
      setLevel(0);
      return undefined;
    }
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return undefined;

    const ctx = new AudioCtx();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);

    const tick = () => {
      analyser.getByteTimeDomainData(data);
      let peak = 0;
      for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
      setLevel(Math.min(1, peak / 64));
      frame.current = requestAnimationFrame(tick);
    };
    tick();

    return () => {
      cancelAnimationFrame(frame.current);
      source.disconnect();
      ctx.close().catch(() => {});
    };
  }, [stream]);

  return level;
}
