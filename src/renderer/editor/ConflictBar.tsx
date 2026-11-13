import type { DocumentModel } from './document';
import { zh } from '../strings';
export function ConflictBar({ document, reload }: { document?: DocumentModel; reload(): void }) {
	return (
		<>
			{document?.conflict !== undefined ? (
				<div className="notice" role="alert">
					<span>{zh.conflict}</span>
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
