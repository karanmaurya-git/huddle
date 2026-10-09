import Icon from './Icons.jsx';

export default function Toasts({ toasts, onDismiss }) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`}>
          <Icon name={t.kind === 'error' ? 'alert' : t.kind === 'success' ? 'check' : 'chat'} size={18} />
          <span>{t.text}</span>
          {onDismiss && (
            <button type="button" className="toast-close" onClick={() => onDismiss(t.id)} aria-label="Dismiss">
              <Icon name="close" size={14} />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
