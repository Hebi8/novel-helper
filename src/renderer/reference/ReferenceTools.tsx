import { useWorkspace } from '../workspace';
import { zh } from '../strings';
export function ReferenceTools({ kind }: { kind: 'split' | 'find' }) {
	const workspace = useWorkspace();
	return (
		<button aria-label={zh[kind]} onClick={kind === 'split' ? workspace.split : workspace.find}>
			<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
				{kind === 'split' ? (
					<>
						<rect x="2.5" y="3.5" width="15" height="13" rx="2" />
						<path d="M10 3.5v13" />
					</>
				) : (
					<>
						<circle cx="8.5" cy="8.5" r="5" />
						<path d="m12 12 5 5" />
					</>
				)}
			</svg>
		</button>
	);
}
