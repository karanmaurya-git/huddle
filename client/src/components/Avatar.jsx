import { hueFor, initials } from '../utils/format.js';

export default function Avatar({ name, size = 40 }) {
  return (
    <span
      className="avatar"
      style={{ width: size, height: size, fontSize: size * 0.38, '--hue': hueFor(name) }}
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  );
}
