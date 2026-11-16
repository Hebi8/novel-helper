import { zh } from '../strings';
export function TreeMenu({
	x,
	y,
	label = zh.chapters,
	close,
	actions,
}: {
	x: number;
	y: number;
	label?: string;
	close(): void;
	actions: { label: string; run(): void }[];
}) {
	return (
		<div
			className="menu-backdrop"
			onMouseDown={close}
			onKeyDown={(event) => {
				if (event.key === 'Escape') {
					close();
				}
			}}
		>
			<div
				className="context-menu"
				role="menu"
				aria-label={label}
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
