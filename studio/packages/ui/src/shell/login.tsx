/**
 * The login screen shown when no admin token is set. Collects a bearer token and
 * hands it to `onSubmit`, which health-probes the server before accepting it.
 */
import { useState } from 'react';
import type { StudioTheme } from './chrome';

export interface LoginScreenProps {
  onSubmit: (token: string) => void | Promise<void>;
  error?: string | null;
  pending?: boolean;
  /** Theme threaded from the shell; defaults to the shell default (`'dark'`). */
  theme?: StudioTheme;
}

export function LoginScreen({ onSubmit, error, pending, theme }: LoginScreenProps) {
  const [token, setToken] = useState('');
  const trimmed = token.trim();
  return (
    <div className="vela-studio vela-login" data-theme={theme ?? 'dark'}>
      <form
        className="vela-login__form"
        onSubmit={(event) => {
          event.preventDefault();
          if (trimmed !== '') void onSubmit(trimmed);
        }}
      >
        <h1 className="vela-login__title">Vela Studio</h1>
        <p className="vela-login__subtitle">Enter your admin token to connect.</p>
        <label className="vela-login__label" htmlFor="vela-admin-token">
          Admin token
        </label>
        <input
          id="vela-admin-token"
          className="vela-login__input"
          type="password"
          autoComplete="off"
          aria-label="Admin token"
          placeholder="Bearer token"
          value={token}
          onChange={(event) => setToken(event.target.value)}
        />
        {error ? (
          <p className="vela-login__error" role="alert">
            {error}
          </p>
        ) : null}
        <button
          className="vela-login__submit"
          type="submit"
          disabled={pending === true || trimmed === ''}
        >
          {pending === true ? 'Connecting…' : 'Connect'}
        </button>
      </form>
    </div>
  );
}
