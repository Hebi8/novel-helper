import { OutlinePanel } from './OutlinePanel';
import { LorePanel } from './LorePanel';
import { AssistantPanel } from './AssistantPanel';
import { zh } from '../strings';
export function RightSidebar({ section, select, hidden }: { section: number; select(i: number): void; hidden: boolean }) {
	return (
		<aside className="sidebar right" style={{ display: hidden ? 'none' : undefined }}>
			<nav className="segments" aria-label={zh.right}>
				{[zh.readOutline, zh.readLore, zh.assistant].map((label, i) => (
					<button key={label} aria-pressed={section === i} onClick={() => select(i)}>
						{label}
					</button>
				))}
			</nav>
			<div hidden={section !== 0}>
				<OutlinePanel />
			</div>
			<div hidden={section !== 1}>
				<LorePanel />
			</div>
			<div hidden={section !== 2}>
				<AssistantPanel />
			</div>
		</aside>
	);
}
