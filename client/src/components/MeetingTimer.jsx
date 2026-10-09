import { useEffect, useState } from 'react';
import Icon from './Icons.jsx';
import { formatDuration } from '../utils/format.js';

export default function MeetingTimer({ since }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <span className="timer" title="Time since you joined">
      <Icon name="clock" size={15} />
      {formatDuration((now - since) / 1000)}
    </span>
  );
}
