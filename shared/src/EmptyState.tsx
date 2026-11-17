import type { ReactNode } from 'react';

export type EmptyStateTone = 'neutral' | 'error' | 'unavailable';

export interface EmptyStateProps {
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
  tone?: EmptyStateTone;
  /** Shows a spinner above the title, for loading states. */
  busy?: boolean;
  children?: ReactNode;
  className?: string;
}

/** Consistent empty, loading, offline and error pane used by every screen. */
export function EmptyState({
  title,
  description,
  actionLabel,
  onAction,
  tone = 'neutral',
  busy = false,
  children,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={className ? `xm-empty xm-empty--${tone} ${className}` : `xm-empty xm-empty--${tone}`}
      role={tone === 'neutral' ? 'status' : 'alert'}
    >
      <div className="xm-empty__inner">
        {busy ? <div className="xm-spinner" aria-hidden="true" /> : null}
        <h2 className="xm-empty__title">{title}</h2>
        {description ? <p className="xm-empty__description">{description}</p> : null}
        {actionLabel && onAction ? (
          <button type="button" className="xm-empty__action" onClick={onAction}>
            {actionLabel}
          </button>
        ) : null}
        {children}
      </div>
    </div>
  );
}
