/**
 * Shared panel primitives: the section scaffold, the loading/error/empty state
 * discipline (with a dedicated `FEATURE_UNCONFIGURED` render), and a handful of
 * dense presentational atoms (badge, drawer, JSON block) every read panel reuses.
 */
import type { ReactNode } from 'react';
import type { AdminError } from '../client/admin-client';
import { formatJson } from './format';

export interface PanelProps {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}

/** The standard panel scaffold: a titled `<section>` with an optional action bar. */
export function Panel({ title, description, actions, children }: PanelProps): ReactNode {
  return (
    <section className="vela-panel">
      <header className="vela-panel__head">
        <div>
          <h1 className="vela-panel__h1">{title}</h1>
          {description !== undefined ? <p className="vela-panel__desc">{description}</p> : null}
        </div>
        {actions !== undefined ? <div className="vela-panel__actions">{actions}</div> : null}
      </header>
      <div className="vela-panel__body">{children}</div>
    </section>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }): ReactNode {
  return (
    <div className="vela-state vela-state--loading" role="status">
      {label}
    </div>
  );
}

export function EmptyState({ label, hint }: { label: string; hint?: string }): ReactNode {
  return (
    <div className="vela-state vela-state--empty">
      <p className="vela-state__label">{label}</p>
      {hint !== undefined ? <p className="vela-state__hint">{hint}</p> : null}
    </div>
  );
}

/**
 * Render an {@link AdminError} with its catalog title/message/hint/docsUrl.
 * `FEATURE_UNCONFIGURED` gets a calmer "not configured" treatment — the backing
 * package is present but unwired, not a failure.
 */
export function AdminErrorView({ error }: { error: AdminError }): ReactNode {
  if (error.code === 'FEATURE_UNCONFIGURED') {
    return (
      <div className="vela-state vela-state--degraded" role="status">
        <p className="vela-state__label">Not configured</p>
        <p className="vela-state__hint">
          {error.hint ?? 'The backing package is present but not wired for this deployment.'}
        </p>
      </div>
    );
  }
  return (
    <div className="vela-state vela-state--error" role="alert">
      <p className="vela-state__label">{error.body.title || 'Request failed'}</p>
      <p className="vela-state__message">{error.body.message}</p>
      {error.hint !== undefined ? <p className="vela-state__hint">{error.hint}</p> : null}
      {error.docsUrl !== undefined ? (
        <a className="vela-state__docs" href={error.docsUrl} target="_blank" rel="noreferrer">
          Documentation
        </a>
      ) : null}
    </div>
  );
}

/** Structural view of a query result — decouples {@link QueryView} from op generics. */
export interface QueryLike<T> {
  data: T | undefined;
  error: AdminError | null;
  isLoading: boolean;
}

/**
 * The loading → error → empty → data ladder every panel renders. Keeps prior
 * data visible during a background refetch (only shows the spinner on the first
 * load), and routes `FEATURE_UNCONFIGURED` through {@link AdminErrorView}.
 */
export function QueryView<T>({
  result,
  children,
  isEmpty,
  emptyLabel = 'Nothing here yet.',
  emptyHint,
  loadingLabel,
}: {
  result: QueryLike<T>;
  children: (data: T) => ReactNode;
  isEmpty?: (data: T) => boolean;
  emptyLabel?: string;
  emptyHint?: string;
  loadingLabel?: string;
}): ReactNode {
  if (result.error !== null) return <AdminErrorView error={result.error} />;
  if (result.data === undefined) return <Loading label={loadingLabel} />;
  if (isEmpty !== undefined && isEmpty(result.data)) {
    return <EmptyState label={emptyLabel} hint={emptyHint} />;
  }
  return <>{children(result.data)}</>;
}

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warn' | 'danger' | 'muted';

export function Badge({
  tone = 'neutral',
  children,
}: {
  tone?: BadgeTone;
  children: ReactNode;
}): ReactNode {
  return <span className={`vela-badge vela-badge--${tone}`}>{children}</span>;
}

/** A right-side detail drawer. Renders nothing when `open` is false. */
export function Drawer({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}): ReactNode {
  if (!open) return null;
  return (
    <div
      className="vela-drawer"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
    >
      <div className="vela-drawer__panel" onClick={(event) => event.stopPropagation()}>
        <header className="vela-drawer__head">
          <h2 className="vela-drawer__title">{title}</h2>
          <button type="button" className="vela-drawer__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <div className="vela-drawer__body">{children}</div>
      </div>
    </div>
  );
}

/**
 * A modal confirmation dialog driven by a `pending` summary — the render half of
 * {@link useConfirmedMutation}'s 428 challenge. Renders nothing when `pending` is
 * `null`; otherwise shows the server's human `summary` and Confirm/Cancel. The
 * Confirm action defaults to the danger tone (destructive by nature).
 */
export function ConfirmDialog({
  pending,
  title = 'Confirm action',
  confirmLabel = 'Confirm',
  busy = false,
  onConfirm,
  onCancel,
}: {
  pending: { summary: string } | null;
  title?: string;
  confirmLabel?: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}): ReactNode {
  if (pending === null) return null;
  return (
    <div
      className="vela-modal"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onCancel}
    >
      <div className="vela-modal__box" onClick={(event) => event.stopPropagation()}>
        <h2 className="vela-modal__title">{title}</h2>
        <p className="vela-modal__body">{pending.summary}</p>
        <div className="vela-modal__actions">
          <button type="button" className="vela-btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="vela-btn vela-btn--danger"
            onClick={onConfirm}
            disabled={busy}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** A monospace, scrollable JSON block. */
export function JsonBlock({ value }: { value: unknown }): ReactNode {
  return <pre className="vela-json">{formatJson(value)}</pre>;
}

/** A `<dl>` of label/value pairs for detail views. */
export function KeyValueList({ rows }: { rows: Array<[string, ReactNode]> }): ReactNode {
  return (
    <dl className="vela-kv">
      {rows.map(([key, value]) => (
        <div className="vela-kv__row" key={key}>
          <dt className="vela-kv__key">{key}</dt>
          <dd className="vela-kv__val">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
