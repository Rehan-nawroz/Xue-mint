import { EmptyState } from '@xue-mint/shared';
import type { GalleryApiError } from '../api/types';
import { isAuthError } from '../api/types';

interface ErrorPaneProps {
  error: GalleryApiError;
  onRetry?: () => void;
}

/**
 * Turns an API failure into a clear next step. Authentication problems ask for a
 * reload on the PC; network problems mention the server; everything else keeps a
 * retry available.
 */
export function ErrorPane({ error, onRetry }: ErrorPaneProps) {
  if (isAuthError(error)) {
    return (
      <EmptyState
        tone="error"
        title="Unlock the gallery on this PC"
        description={`This browser has no gallery session. Open ${window.location.origin} on the PC that stores the photos, then reload this page.`}
        actionLabel="Reload the page"
        onAction={() => window.location.reload()}
      />
    );
  }

  if (error.code === 'FORBIDDEN') {
    return (
      <EmptyState
        tone="error"
        title="Open the gallery on the PC"
        description={error.message}
        actionLabel="Reload the page"
        onAction={() => window.location.reload()}
      />
    );
  }

  if (error.status === 0 || error.code === 'NETWORK') {
    return (
      <EmptyState
        tone="unavailable"
        title="Can't reach the server"
        description="Make sure the PC is on and the gallery server is running, then try again. Your photos are still on the PC."
        actionLabel="Try again"
        onAction={onRetry}
      />
    );
  }

  return (
    <EmptyState
      tone="error"
      title="Something went wrong"
      description={error.message}
      actionLabel={onRetry ? 'Try again' : undefined}
      onAction={onRetry}
    />
  );
}
