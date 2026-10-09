import { useEffect, useRef, useState } from 'react';
import Icon from './Icons.jsx';
import Avatar from './Avatar.jsx';

const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export default function ChatPanel({ messages, me, onSend }) {
  const [text, setText] = useState('');
  const listRef = useRef(null);

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages]);

  function submit(event) {
    event.preventDefault();
    const message = text.trim();
    if (message && onSend(message)) setText('');
  }

  return (
    <div className="chat">
      <ul className="chat-list" ref={listRef}>
        {messages.length === 0 && <li className="empty">No messages yet. Say hello.</li>}
        {messages.map((m, i) => {
          const mine = m.userId === me.userId;
          const grouped = i > 0 && messages[i - 1].userId === m.userId && m.timestamp - messages[i - 1].timestamp < 60000;
          return (
            <li key={m.id} className={`msg${mine ? ' mine' : ''}${grouped ? ' grouped' : ''}`}>
              {!grouped && !mine && <Avatar name={m.username} size={28} />}
              <div className="msg-body">
                {!grouped && (
                  <div className="msg-meta">
                    <strong>{mine ? 'You' : m.username}</strong>
                    <time>{clock(m.timestamp)}</time>
                  </div>
                )}
                {/* Plain text only: React escapes it, so chat cannot inject HTML. */}
                <p>{m.message}</p>
              </div>
            </li>
          );
        })}
      </ul>
      <form className="chat-form" onSubmit={submit}>
        <input className="input" value={text} onChange={(e) => setText(e.target.value)} maxLength={500} placeholder="Message everyone" aria-label="Message" />
        <button type="submit" className="btn btn-primary btn-icon" disabled={!text.trim()} aria-label="Send message">
          <Icon name="send" size={18} />
        </button>
      </form>
    </div>
  );
}
