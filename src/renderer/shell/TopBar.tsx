import { ReferenceTools } from '../reference/ReferenceTools';
import { zh } from '../strings';
import { assistantEvents } from '../assistant/events';
export function TopBar({ name, left, right }: { name?: string; left(): void; right(): void }) {
	return (
		<header className="topbar">
			<button aria-label={zh.left} onClick={left}>
				<PanelIcon />
			</button>
			<ReferenceTools kind="split" />
			<strong>{name ?? zh.app}</strong>
			<span className="grow" />
			<button aria-label={zh.assistantSnapshots} disabled={!name} onClick={() => window.dispatchEvent(new Event(assistantEvents.history))}>
				<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
					<path d="M4 5.5h12v11H4zM6 3h8M2 9V7a7.5 7.5 0 1 1 0 6M2 9h4" />
				</svg>
			</button>
			<ReferenceTools kind="find" />
			<button
				aria-label={zh.settings}
				onClick={() => {
					void window.novel.settings.open();
				}}
			>
				<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
					<circle cx="10" cy="10" r="2.5" />
					<path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4" />
				</svg>
			</button>
			<button aria-label={zh.right} onClick={right}>
				<PanelIcon right />
			</button>
		</header>
	);
}
function PanelIcon({ right = false }: { right?: boolean }) {
	return (
		<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
			<rect x="2.5" y="3.5" width="15" height="13" rx="2" />
			<path d={`M${right ? 12.5 : 7.5} 3.5v13`} />
		</svg>
	);
}
