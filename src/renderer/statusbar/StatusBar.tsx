import { useWorkspace } from '../workspace';
import { describeBuoy } from '../strings';
import type { DocumentModel } from '../editor/document';
import { useDocument } from '../editor/useDocument';
import type { UsageStatus } from '../../shared/api';
import { dollars } from '../../core/usage';
import { zh } from '../strings';
export function StatusBar({ status, document, toggle }: { status: UsageStatus; document?: DocumentModel; toggle(): void }) {
	useDocument(document);
	const workspace = useWorkspace();
	const words = document ? Array.from(document.text.replace(/\s/gu, '')).length : 0;
	return (
		<footer className="statusbar">
			<button onClick={toggle} title={status.missingKey ? zh.missingKey : status.problem}>
				<span className={`status-dot ${status.state}`} />
				{zh.continuation} · {zh[status.state]}
			</button>
			<button
				onClick={() => {
					void workspace.report('usageReport');
				}}
			>
				{zh.today} {status.today.requests} {zh.requests} {status.priced ? ` · ${dollars(status.today.cost)}` : ''}
			</button>
			{workspace.chapter ? (
				<button className="status-buoy" onClick={workspace.showOutline}>
					{describeBuoy(workspace.buoy?.state, workspace.buoy?.lost)}
				</button>
			) : null}
			<span className="grow" />
			<span>
				{words.toLocaleString()} {zh.words}
			</span>
		</footer>
	);
}
