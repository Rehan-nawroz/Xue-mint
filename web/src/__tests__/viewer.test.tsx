import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

  it('renames the current file through the rename dialog', async () => {
    const onRename = vi.fn(async (_asset, filename: string) => filename);
    render(
      <Viewer
        assets={assets}
        index={1}
        onClose={() => undefined}
        onIndexChange={() => undefined}
        onRename={onRename}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    const input = screen.getByLabelText('File name');
    expect(input).toHaveValue('two.jpg');
    fireEvent.change(input, { target: { value: 'Trip' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));

    await waitFor(() => expect(onRename).toHaveBeenCalledWith(assets[1], 'Trip'));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Rename this file' })).not.toBeInTheDocument()
    );
  });

  it('confirms before deleting and reports server errors in the dialog', async () => {
    const onDelete = vi.fn(async () => {
      throw new Error('The file is no longer in the photos folder.');
    });
    render(
      <Viewer
        assets={assets}
        index={0}
        onClose={() => undefined}
        onIndexChange={() => undefined}
        onDelete={onDelete}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(screen.getByRole('alertdialog', { name: 'Delete this photo?' })).toBeInTheDocument();
    expect(onDelete).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Delete photo' }));
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith(assets[0]));
    expect(
      await screen.findByText('The file is no longer in the photos folder.')
    ).toBeInTheDocument();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('keeps arrow-key navigation out of the rename field', () => {
    const { onIndexChange } = renderViewer();
    render(
      <Viewer
        assets={assets}
        index={1}
        onClose={() => undefined}
        onIndexChange={onIndexChange}
        onRename={async (_asset, filename) => filename}
      />
    );
    fireEvent.click(screen.getAllByRole('button', { name: 'Rename' })[0]);
    fireEvent.keyDown(screen.getByLabelText('File name'), { key: 'ArrowRight' });
    expect(onIndexChange).not.toHaveBeenCalled();
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
