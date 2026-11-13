import { useDocument } from './useDocument';
import type { DocumentModel } from './document';
import { zh } from '../strings';
import { showConflictDiff } from '../assistant/events';
export function ConflictBar({ document, reload }: { document?: DocumentModel; reload(): void }) {
	useDocument(document);
	return (
		<>
			{document?.conflict !== undefined ? (
				<div className="notice" role="alert">
					<span>{zh.conflict}</span>
					<button
						onClick={() =>
							showConflictDiff({
								path: document.path,
								before: document.text,
								after: document.conflict!,
								canOpen: false,
								beforeLabel: zh.assistantMine,
								afterLabel: zh.assistantDisk,
							})
						}
					>
						{zh.assistantDiff}
					</button>
					<button
						onClick={() => {
							void document.save(true);
						}}
					>
						{zh.keepMine}
					</button>
					<button
						onClick={() => {
							document.useDisk();
							reload();
						}}
					>
						{zh.useDisk}
					</button>
				</div>
			) : null}
			{document?.error ? (
				<div className="notice" role="alert">
					{document.error}
				</div>
			) : null}
		</>
	);
}
