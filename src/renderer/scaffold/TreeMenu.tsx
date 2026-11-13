import { zh } from '../strings';
export function TreeMenu({ x, y, close, actions }: { x: number; y: number; close(): void; actions: { label: string; run(): void }[] }) {
	return (
		<div
			className="menu-backdrop"
			onMouseDown={close}
			onKeyDown={(event) => {
				if (event.key === 'Escape' && !event.nativeEvent.isComposing && event.keyCode !== 229) {
					close();
				}
			}}
		>
			<div
				className="context-menu"
				role="menu"
				aria-label={zh.chapters}
				style={{ left: x, top: y }}
				onMouseDown={(event) => event.stopPropagation()}
			>
				{actions.map((action, i) => (
					<button
						key={action.label}
						role="menuitem"
						autoFocus={i === 0}
						onClick={() => {
							close();
							action.run();
						}}
					>
						{action.label}
					</button>
				))}
			</div>
		</div>
	);
}
