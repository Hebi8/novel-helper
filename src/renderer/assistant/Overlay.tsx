import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { zh } from '../strings';

export function Overlay({ title, close, children, wide = false }: { title: string; close(): void; children: ReactNode; wide?: boolean }) {
	const element = useRef<HTMLDivElement>(null);
	const closeRef = useRef(close);
	closeRef.current = close;
	useEffect(() => {
		const previous = document.activeElement as HTMLElement | null;
		const dialog = element.current!;
		dialog.querySelector<HTMLButtonElement>('button')!.focus();
		const key = (event: KeyboardEvent) => {
			if (event.key === 'Escape' && !event.isComposing) {
				event.preventDefault();
				event.stopPropagation();
				closeRef.current();
			}
			if (event.key === 'Tab') {
				const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], textarea, [tabindex="0"]')];
				const first = focusable[0];
				const last = focusable.at(-1);
				if (event.shiftKey && document.activeElement === first) {
					event.preventDefault();
					last?.focus();
				}
				if (!event.shiftKey && document.activeElement === last) {
					event.preventDefault();
					first?.focus();
				}
			}
		};
		document.addEventListener('keydown', key, true);
		return () => {
			document.removeEventListener('keydown', key, true);
			previous?.focus();
		};
	}, []);
	return createPortal(
		<div className={`assistant-overlay${wide ? ' assistant-overlay-wide' : ''}`}>
			<div className="assistant-dialog" role="dialog" aria-modal="true" aria-label={title} ref={element}>
				<header>
					<strong>{title}</strong>
					<button aria-label={zh.assistantClose} onClick={close}>
						×
					</button>
				</header>
				{children}
			</div>
		</div>,
		document.querySelector('.writing')!,
	);
}
