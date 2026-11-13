import { useState } from 'react';
import type { BuoyAction, OutlineItem } from '../../shared/api';
import { useWorkspace } from '../workspace';
import { describeBuoy, zh } from '../strings';
import { errorMessage } from '../errors';
export function OutlinePanel() {
	const workspace = useWorkspace();
	const [selected, setSelected] = useState<string>();
	const [error, setError] = useState('');
	const [pending, setPending] = useState(false);
	const { nodes } = workspace.reference;
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const picked = selected === undefined ? undefined : byId.get(selected);
	const next = picked?.next === undefined ? undefined : byId.get(picked.next);
	const act = async (action: BuoyAction, id?: string) => {
		if (!workspace.chapter) {
			setError(zh.buoyNoChapter);
			return;
		}
		setPending(true);
		try {
			if (await workspace.saveAll()) {
				await window.novel.buoys.act(workspace.chapter, action, id);
			}
			setError('');
		} catch (error) {
			setError(errorMessage(error));
		} finally {
			setPending(false);
		}
	};
	const role = (node: OutlineItem) => {
		if (workspace.buoy?.lost) {
			return;
		}
		const state = workspace.buoy?.state;
		const index = state?.nodes.findIndex((ref) => ref.id === node.id) ?? -1;
		if (!state || index < 0) {
			return;
		}
		return state.kind === 'in'
			? zh.buoyRoles.in
			: state.kind === 'parallel'
				? zh.buoyRoles.parallel
				: index === 0
					? zh.buoyRoles.from
					: zh.buoyRoles.to;
	};
	const branch = (node: OutlineItem, depth: number) => (
		<div key={node.id} role="treeitem">
			<button
				className={`tree-row outline-row ${selected === node.id ? 'selected' : ''}`}
				style={{ paddingLeft: 12 + depth * 12 }}
				onClick={() => setSelected(node.id)}
			>
				<span>{node.title}</span>
				{role(node) ? <small className="buoy-mark">{role(node)}</small> : null}
			</button>
			{node.links.map((link, i) => (
				<div key={i} className={`outline-link ${link.problem ? 'broken' : ''}`} style={{ paddingLeft: 18 + depth * 12 }}>
					→ {link.raw}
					{link.problem ? ` · ${link.problem === 'missing' ? zh.linkMissing : zh.linkAmbiguous}` : ''}
				</div>
			))}
			{node.children.length ? <div role="group">{node.children.map((id) => branch(byId.get(id)!, depth + 1))}</div> : null}
		</div>
	);
	const card = (node: OutlineItem, after = false) => (
		<article className={`outline-card ${after ? 'next' : ''}`}>
			{after ? <small>{zh.nextNode}</small> : null}
			<h3>{node.title}</h3>
			<div className="reference-text">{node.text}</div>
			{node.file ? (
				<button
					onClick={() => {
						void workspace.open(node.file!, { line: node.line });
					}}
				>
					{zh.openMiddle}
				</button>
			) : null}
		</article>
	);
	return (
		<div className="reference-panel">
			<div className="panel-actions">
				{(
					[
						['back', zh.buoyBack],
						['forward', zh.buoyForward],
						['relocate', zh.buoyRelocate],
					] as const
				).map(([action, label]) => (
					<button
						key={action}
						disabled={pending}
						onClick={() => {
							void act(action);
						}}
					>
						{label}
					</button>
				))}
			</div>
			<div className="position-summary">
				{workspace.chapter
					?.split('/')
					.pop()
					?.replace(/\.(md|txt)$/, '')}
				<br />
				{describeBuoy(workspace.buoy?.state, workspace.buoy?.lost)}
			</div>
			{error ? (
				<p className="panel-error" role="alert">
					{error}
				</p>
			) : null}
			<div className="reference-list" role="tree" aria-label={zh.readOutline}>
				{nodes[0] ? branch(nodes[0], 0) : null}
			</div>
			{picked ? (
				<>
					{card(picked)}
					<div className="panel-actions">
						{(
							[
								['in', zh.buoyIn],
								['bridge', zh.buoyBridge],
								['parallel', zh.buoyParallel],
								['dropSecond', zh.buoyDrop],
							] as const
						).map(([action, label]) => (
							<button
								key={action}
								disabled={pending}
								onClick={() => {
									void act(action, picked.id);
								}}
							>
								{label}
							</button>
						))}
					</div>
					{next ? card(next, true) : null}
				</>
			) : null}
		</div>
	);
}
