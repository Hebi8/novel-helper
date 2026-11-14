import { useEffect, useRef } from 'react';
import type { ReportKind } from '../../shared/api';
import { Markdown } from '../assistant/Markdown';
import { zh } from '../strings';
import type { DocumentModel } from './document';
import { useDocument } from './useDocument';

interface Props {
	kind: ReportKind;
	document: DocumentModel;
	active: boolean;
	visible?: boolean;
	side?: 'left' | 'right';
	focused?(): void;
}

export function ReportView({ kind, document: model, active, visible = active, side = 'left', focused }: Props) {
	useDocument(model);
	const container = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (active && !container.current?.contains(window.document.activeElement)) {
			container.current?.focus();
		}
	}, [active]);
	return (
		<div className={`editor-pane pane-${side}`} onFocus={focused} style={{ display: visible ? undefined : 'none' }}>
			<div className="report-view" ref={container} tabIndex={-1} aria-label={zh[kind]}>
				<Markdown text={model.text} headingOffset={0} className="report-markdown" />
			</div>
		</div>
	);
}
