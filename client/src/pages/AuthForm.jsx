import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { errorMessage } from '../services/api.js';
import Icon from '../components/Icons.jsx';

// A looping, CSS-only mock of a meeting so the first screen shows what the product is.
function BrandMock() {
  const tiles = [
    { name: 'Maya', hue: 262, speaking: true },
    { name: 'Dev', hue: 190, muted: true },
    { name: 'Lena', hue: 330 },
    { name: 'Omar', hue: 150, hand: true },
  ];
  return (
    <div className="mock" aria-hidden="true">
      <div className="mock-grid">
        {tiles.map((t, i) => (
          <div key={t.name} className={`mock-tile${t.speaking ? ' speaking' : ''}`} style={{ '--hue': t.hue, '--i': i }}>
            <span className="mock-avatar">{t.name[0]}</span>
            <span className="mock-name">
              {t.muted && <Icon name="micOff" size={12} />}
              {t.name}
            </span>
            {t.hand && <span className="mock-hand"><Icon name="hand" size={14} /></span>}
          </div>
        ))}
      </div>
      <div className="mock-dock">
        <span><Icon name="mic" size={16} /></span>
        <span><Icon name="video" size={16} /></span>
        <span className="on"><Icon name="screen" size={16} /></span>
        <span><Icon name="chat" size={16} /></span>
      </div>
      <div className="mock-bubble"><Icon name="chat" size={14} /> Shared the slides</div>
    </div>
  );
}

export default function AuthForm({ mode }) {
  const isRegister = mode === 'register';
  const { login, register } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const update = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));

  async function submit(event) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (isRegister) await register(form);
      else await login({ email: form.email, password: form.password });
      navigate(location.state?.from || '/', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <main className="auth">
      <section className="auth-brand">
        <span className="brand brand-lg"><span className="brand-mark" />Huddle</span>
        <h1>Meetings that feel like the room you wish you were in.</h1>
        <p>Crisp video, screen sharing and chat, with a media server that keeps big rooms smooth.</p>
        <BrandMock />
      </section>

      <section className="auth-panel">
        <form className="auth-card" onSubmit={submit} noValidate>
          <h2>{isRegister ? 'Create your account' : 'Welcome back'}</h2>
          <p className="muted">{isRegister ? 'It takes a few seconds.' : 'Log in to start or join a meeting.'}</p>

          {isRegister && (
            <label className="field">
              <span>Name</span>
              <input className="input" value={form.name} onChange={update('name')} required minLength={2} maxLength={50} autoComplete="name" placeholder="Your name" />
            </label>
          )}
          <label className="field">
            <span>Email</span>
            <input className="input" type="email" value={form.email} onChange={update('email')} required autoComplete="email" placeholder="you@example.com" />
          </label>
          <label className="field">
            <span>Password</span>
            <div className="input-wrap">
              <input
                className="input"
                type={showPassword ? 'text' : 'password'}
                value={form.password}
                onChange={update('password')}
                required
                minLength={isRegister ? 8 : undefined}
                autoComplete={isRegister ? 'new-password' : 'current-password'}
                placeholder={isRegister ? 'At least 8 characters' : 'Your password'}
              />
              <button type="button" className="input-toggle" onClick={() => setShowPassword((v) => !v)} aria-label={showPassword ? 'Hide password' : 'Show password'}>
                <Icon name={showPassword ? 'eyeOff' : 'eye'} size={18} />
              </button>
            </div>
          </label>

          {error && <p className="form-error" role="alert"><Icon name="alert" size={16} />{error}</p>}

          <button type="submit" className="btn btn-primary btn-wide" disabled={busy}>
            {busy ? <span className="spinner" aria-label="Please wait" /> : isRegister ? 'Create account' : 'Log in'}
          </button>

          <p className="auth-switch">
            {isRegister ? (
              <>Already have an account? <Link to="/login" state={location.state}>Log in</Link></>
            ) : (
              <>New to Huddle? <Link to="/register" state={location.state}>Create an account</Link></>
            )}
          </p>
        </form>
      </section>
    </main>
  );
}
