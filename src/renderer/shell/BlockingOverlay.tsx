import { useEffect, useRef } from 'react';

export function BlockingOverlay({ text }: { text?: string }) {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		(document.activeElement as HTMLElement | null)?.blur();
		ref.current?.focus();
		const block = (event: Event) => {
			event.preventDefault();
			event.stopPropagation();
		};
		const events = ['keydown', 'keypress', 'beforeinput', 'paste', 'drop'] as const;
		events.forEach((name) => window.addEventListener(name, block, true));
		return () => {
			events.forEach((name) => window.removeEventListener(name, block, true));
		};
	}, []);
	return (
		<div ref={ref} className="popover-backdrop icloud-saving-backdrop" role="status" aria-live="polite" tabIndex={-1}>
			{text ? <div className="icloud-saving-card">{text}</div> : null}
		</div>
	);
}
