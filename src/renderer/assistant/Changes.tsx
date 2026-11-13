import { changeKind, type Change } from '../../core/snapshot';
import { zh } from '../strings';

export function Changes({ changes, record, diff }: { changes: Change[]; record?: number; diff(record: number, path: string): void }) {
	return (
		<ul className="assistant-changes">
			{changes.map((change) => (
				<li key={change.path}>
					<span className={`assistant-change-kind ${changeKind(change)}`}>{zh.assistantChangeKinds[changeKind(change)]}</span>
					<span className="assistant-change-path" title={change.path}>
						{change.path}
					</span>
					{record !== undefined ? (
						<button onClick={() => diff(record, change.path)} aria-label={`${zh.assistantDiff} · ${change.path}`}>
							{zh.assistantDiff}
						</button>
					) : null}
				</li>
			))}
		</ul>
	);
}
