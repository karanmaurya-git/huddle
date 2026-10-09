import { useState } from 'react';
import Icon from './Icons.jsx';

/** The meeting code as a ticket stub, with a one-click invite link copy. */
export default function CodeTicket({ code, onCopied }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    const link = `${window.location.origin}/meeting/${code}`;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      onCopied?.('Invite link copied');
      setTimeout(() => setCopied(false), 1800);
    } catch {
      onCopied?.(link);
    }
  }

  return (
    <div className="ticket">
      <span className="ticket-code">{code}</span>
      <button type="button" className="ticket-copy" onClick={copy} aria-label="Copy invite link">
        <Icon name={copied ? 'check' : 'copy'} size={16} />
        <span>{copied ? 'Copied' : 'Copy link'}</span>
      </button>
    </div>
  );
}
