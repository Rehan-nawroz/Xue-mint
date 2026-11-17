import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Viewer } from '@xue-mint/shared';
import { makeAsset } from '../test/fixtures';

const assets = [
  makeAsset({ id: 'one', filename: 'one.jpg' }),
  makeAsset({ id: 'two', filename: 'two.jpg' }),
  makeAsset({ id: 'three', filename: 'three.jpg', type: 'video' }),
];

function renderViewer(index = 1) {
  const onClose = vi.fn();
  const onIndexChange = vi.fn();
  const utils = render(
    <Viewer
      assets={assets}
      index={index}
      onClose={onClose}
      onIndexChange={onIndexChange}
    />
  );
  return { ...utils, onClose, onIndexChange };
}

describe('Viewer', () => {
  it('renders an accessible dialog with navigation controls', () => {
    renderViewer();
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByText('2 of 3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous photo' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Next photo' })).toBeEnabled();
  });

  it('navigates with arrow keys and closes with Escape', () => {
    const { onClose, onIndexChange } = renderViewer();
    const dialog = screen.getByRole('dialog');

    fireEvent.keyDown(dialog, { key: 'ArrowRight' });
    expect(onIndexChange).toHaveBeenCalledWith(2);
    fireEvent.keyDown(dialog, { key: 'ArrowLeft' });
    expect(onIndexChange).toHaveBeenCalledWith(0);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('disables navigation at the ends of the timeline', () => {
    const { onIndexChange } = renderViewer(0);
    expect(screen.getByRole('button', { name: 'Previous photo' })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowLeft' });
    expect(onIndexChange).not.toHaveBeenCalled();
  });

  it('navigates with a touch swipe', () => {
    const { onIndexChange } = renderViewer();
    const stage = document.querySelector('.xm-viewer__stage') as HTMLElement;

    fireEvent.touchStart(stage, { touches: [{ clientX: 250 }] });
    fireEvent.touchEnd(stage, { changedTouches: [{ clientX: 100 }] });
    expect(onIndexChange).toHaveBeenCalledWith(2);

    fireEvent.touchStart(stage, { touches: [{ clientX: 100 }] });
    fireEvent.touchEnd(stage, { changedTouches: [{ clientX: 250 }] });
    expect(onIndexChange).toHaveBeenCalledWith(0);
  });

  it('recovers from a missing original without closing the viewer', () => {
    renderViewer(0);
    fireEvent.error(screen.getByRole('img', { name: 'one.jpg' }));
    expect(screen.getByText('This file could not be loaded.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('moves focus into the dialog and restores it when closed', () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'open';
    document.body.appendChild(trigger);
    trigger.focus();

    const { unmount } = render(
      <Viewer assets={assets} index={0} onClose={() => undefined} onIndexChange={() => undefined} />
    );
    expect(screen.getByRole('button', { name: 'Close viewer' })).toHaveFocus();

    unmount();
    expect(trigger).toHaveFocus();
    trigger.remove();
  });
});
