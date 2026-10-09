import Icon from './Icons.jsx';
import { ROLE_LABEL } from '../utils/format.js';

const ICON = { host: 'crown', moderator: 'shield', participant: 'user' };

export default function RoleBadge({ role, compact = false }) {
  return (
    <span className={`role role-${role}${compact ? ' role-compact' : ''}`} title={ROLE_LABEL[role]}>
      <Icon name={ICON[role] || 'user'} size={compact ? 13 : 14} />
      {!compact && ROLE_LABEL[role]}
    </span>
  );
}
