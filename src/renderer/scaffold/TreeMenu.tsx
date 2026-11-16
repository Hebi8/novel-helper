import { Fragment } from 'react';
import { zh } from '../strings';
export interface TreeMenuAction {
	label: string;
	run(): void;
	danger?: boolean;
	separatorBefore?: boolean;
}
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
	actions: TreeMenuAction[];
}) {
	return (
		<div
			className="menu-backdrop"
			onMouseDown={close}
			onKeyDown={(event) => {
				if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
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
					<Fragment key={action.label}>
						{action.separatorBefore ? <hr /> : null}
						<button
							role="menuitem"
							className={action.danger ? 'danger' : undefined}
							autoFocus={i === 0}
							onClick={() => {
								close();
								action.run();
							}}
						>
							{action.label}
						</button>
					</Fragment>
				))}
			</div>
		</div>
	);
}
