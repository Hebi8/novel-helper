import { memo } from 'react';
import type { Item } from '../../core/transcript';
import { zh } from '../strings';
import { Markdown } from './Markdown';
import { Changes } from './Changes';

export const TranscriptItem = memo(function TranscriptItem({
	item,
	busy,
	diff,
	revert,
	answer,
}: {
	item: Item;
	busy: boolean;
	diff(record: number, path: string): void;
	revert(record: number, mode: 'turn' | 'undo'): void;
	answer(id: string, allow: boolean): void;
}) {
	switch (item.kind) {
		case 'user':
			return (
				<div className="assistant-user">
					<div>{item.text}</div>
					{item.context ? <small>{item.context}</small> : null}
				</div>
			);
		case 'agent':
			return (
				<div className="assistant-reply">
					<Markdown text={item.text} />
				</div>
			);
		case 'thought':
			return (
				<details className="assistant-thought">
					<summary>{zh.assistantThought}</summary>
					<div>{item.text}</div>
				</details>
			);
		case 'tool':
			return (
				<div className={`assistant-tool ${item.status}`} title={item.paths.join('\n')}>
					<span>{item.title}</span>
					<small>{zh.assistantToolStatus[item.status]}</small>
				</div>
			);
		case 'plan':
			return (
				<div className="assistant-plan">
					<strong>{zh.assistantPlan}</strong>
					<ul>
						{item.entries.map((entry, i) => (
							<li key={i} data-status={entry.status}>
								{entry.content}
							</li>
						))}
					</ul>
				</div>
			);
		case 'notice':
			return (
				<div className={`assistant-notice ${item.level}`} role={item.level === 'error' ? 'alert' : 'status'}>
					{item.text}
					{item.detail ? <pre>{item.detail}</pre> : null}
				</div>
			);
		case 'ask':
			return (
				<div className="assistant-permission" aria-label={zh.assistantPermission}>
					<strong>{item.title}</strong>
					{item.detail ? <pre>{item.detail}</pre> : null}
					{item.answer !== undefined ? (
						<div>{item.answer}</div>
					) : item.closed ? (
						<div>{zh.assistantAskClosed}</div>
					) : (
						<div className="assistant-actions">
							<button onClick={() => answer(item.id, true)}>{zh.assistantAllow}</button>
							<button onClick={() => answer(item.id, false)}>{zh.assistantDeny}</button>
						</div>
					)}
				</div>
			);
		case 'turn':
			return (
				<div className="assistant-turn" data-record={item.record}>
					{item.stop !== 'end_turn' ? (
						<div className="assistant-turn-status">
							{item.stop === 'reverted'
								? item.target !== undefined
									? `${zh.assistantReverted} #${item.target}`
									: zh.snapshotReverted
								: (zh.assistantStopReasons[item.stop as keyof typeof zh.assistantStopReasons] ?? item.stop)}
						</div>
					) : null}
					<strong>
						{item.changes.length ? `${zh.assistantChanges} · ${item.changes.length} ${zh.assistantFiles}` : zh.assistantUnchanged}
					</strong>
					<Changes changes={item.changes} record={item.record} diff={diff} />
					{item.record !== undefined && item.changes.length ? (
						<button disabled={busy} onClick={() => revert(item.record!, item.stop === 'reverted' ? 'undo' : 'turn')}>
							{item.stop === 'reverted' ? zh.assistantUndoRevert : zh.assistantRevert}
						</button>
					) : null}
				</div>
			);
	}
});
