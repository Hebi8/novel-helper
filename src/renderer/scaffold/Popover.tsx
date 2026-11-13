import { useEffect, useRef, type ReactNode } from 'react';
import { zh } from '../strings';
export function Popover({
	title,
	children,
	close,
	submit,
	pending = false,
	multiline = false,
}: {
	title: string;
	children: ReactNode;
	close(): void;
	submit(): void;
	pending?: boolean;
	multiline?: boolean;
}) {
	const element = useRef<HTMLDivElement>(null);
	const composing = useRef(false);
	useEffect(() => {
		element.current?.querySelector<HTMLElement>('input, textarea, select, button')?.focus();
	}, []);
	return (
		<div className="popover-backdrop">
			<div
				ref={element}
				className="input-popover finish-popover"
				role="dialog"
				aria-label={title}
				onCompositionStart={() => {
					composing.current = true;
				}}
				onCompositionEnd={() => {
					composing.current = false;
				}}
				onKeyDown={(event) => {
					if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) {
						return;
					}
					if (event.key === 'Escape' && !pending) {
						event.stopPropagation();
						close();
					}
					if (event.key === 'Enter' && !pending && !multiline && event.target instanceof HTMLInputElement) {
						event.preventDefault();
						submit();
					}
				}}
			>
				<h3>{title}</h3>
				{children}
				<div className="panel-actions">
					<button disabled={pending} onClick={close}>
						{zh.cancel}
					</button>
					<button disabled={pending} onClick={submit}>
						{zh.confirm}
					</button>
				</div>
			</div>
		</div>
	);
}
