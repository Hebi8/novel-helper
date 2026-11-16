import { useState } from 'react';
import type { ConflictDiff, ConflictResolution } from '../../shared/api';
import { DiffOverlay } from '../assistant/DiffOverlay';
import { Overlay } from '../assistant/Overlay';
import { errorMessage } from '../errors';
import { zh } from '../strings';

export function ConflictCopyOverlay({
	diff,
	close,
	blockReason,
	onResolved,
	onError,
}: {
	diff: ConflictDiff;
	close(): void;
	blockReason(paths: readonly string[]): string | undefined;
	onResolved(path: string): void;
	onError(message: string): void;
}) {
	const [confirming, setConfirming] = useState<ConflictResolution>();
	const [busy, setBusy] = useState(false);

	const execute = async (action: ConflictResolution) => {
		const blocked = blockReason([diff.original, diff.path]);
		if (blocked) {
			onError(blocked);
			close();
			return;
		}
		setBusy(true);
		try {
			await window.novel.book.resolveConflict(diff.path, action);
			onResolved(diff.path);
			close();
		} catch (error) {
			onError(errorMessage(error));
			close();
		} finally {
			setBusy(false);
		}
	};

	if (confirming) {
		const replace = confirming === 'replace';
		return (
			<Overlay
				title={replace ? zh.conflictReplace : zh.conflictDelete}
				close={() => {
					if (!busy) {
						setConfirming(undefined);
					}
				}}
			>
				<div className="assistant-confirm">
					<p>{replace ? zh.conflictReplaceConfirm(diff.path, diff.original) : zh.conflictDeleteConfirm(diff.path)}</p>
					<div className="assistant-actions">
						<button disabled={busy} onClick={() => setConfirming(undefined)}>
							{zh.cancel}
						</button>
						<button
							disabled={busy}
							onClick={() => {
								void execute(confirming);
							}}
						>
							{replace ? zh.conflictConfirmReplace : zh.conflictConfirmDelete}
						</button>
					</div>
				</div>
			</Overlay>
		);
	}

	return (
		<DiffOverlay
			diff={{
				path: diff.path,
				before: diff.before,
				after: diff.after,
				canOpen: false,
				beforeLabel: `${zh.conflictOriginal} · ${diff.original}`,
				afterLabel: `${zh.conflictCopy} · ${diff.path}`,
			}}
			close={close}
			open={() => {}}
			actions={
				<footer>
					<button onClick={() => setConfirming('replace')}>{zh.conflictReplace}</button>
					<button onClick={() => setConfirming('trash')}>{zh.conflictDelete}</button>
				</footer>
			}
		/>
	);
}
