import { useEffect, useRef } from 'react';
import type { TrashPreview } from '../../shared/structure';
import { zh } from '../strings';

export function TrashDialog({
	preview,
	pending = false,
	close,
	submit,
}: {
	preview: TrashPreview;
	pending?: boolean;
	close(): void;
	submit(): void;
}) {
	const cancelRef = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		cancelRef.current?.focus();
	}, []);
	const title = zh.trashTitle(preview.name);
	const hasCompanions = preview.outlines > 0 || preview.summaries > 0 || preview.hasBuoys;
	const summary =
		preview.kind === 'level'
			? `${zh.trashLevelSummary(preview.sublevels, preview.sublevelUnit, preview.chapters, preview.words)}${hasCompanions ? zh.trashCompanionsLead : ''}`
			: preview.kind === 'chapter'
				? `${zh.trashChapterSummary(preview.words)}${hasCompanions ? zh.trashCompanionsLead : ''}`
				: zh.trashLoreSummary(preview.path);
	const companionCounts = [
		preview.outlines ? zh.trashOutlineCount(preview.outlines) : '',
		preview.summaries ? zh.trashSummaryCount(preview.summaries) : '',
	]
		.filter(Boolean)
		.join('、');

	return (
		<div className="popover-backdrop">
			<div
				className="input-popover trash-dialog"
				role="dialog"
				aria-label={title}
				onKeyDown={(event) => {
					if (event.nativeEvent.isComposing) {
						return;
					}
					if (event.key === 'Escape' && !pending) {
						event.stopPropagation();
						close();
					}
				}}
			>
				<h3>{title}</h3>
				<p>{summary}</p>
				{hasCompanions ? (
					<ul>
						{companionCounts ? <li>{companionCounts}</li> : null}
						{preview.hasBuoys ? <li>{zh.trashBuoyRecord}</li> : null}
					</ul>
				) : null}
				<p className="trash-hint">{zh.trashPutBackHint}</p>
				<div className="panel-actions trash-actions">
					<button ref={cancelRef} type="button" disabled={pending} onClick={close}>
						{zh.cancel}
					</button>
					<button type="button" className="danger" disabled={pending} onClick={submit}>
						{zh.confirmMoveToTrash}
					</button>
				</div>
			</div>
		</div>
	);
}
