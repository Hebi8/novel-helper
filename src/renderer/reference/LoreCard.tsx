import type { LoreEntry } from '../../core/library';
import { groupOf } from '../../core/loreGroups';
import { headChars } from '../../core/text';
import { zh } from '../strings';
export function LoreCard({ entry, full = false, open }: { entry: LoreEntry; full?: boolean; open(): void }) {
	const cut = headChars(entry.summary ?? entry.body, 300);
	return (
		<article className="lore-card">
			<h3>{entry.name}</h3>
			<div className="lore-meta">
				{groupOf(entry)} · {entry.always ? zh.always : zh.notAlways}
			</div>
			{entry.aliases.length ? (
				<p>
					{zh.aliases}：{entry.aliases.join('、')}
				</p>
			) : null}
			{entry.error ? <p role="alert">{entry.error}</p> : null}
			{full ? (
				<>
					{entry.summary ? <p>{entry.summary}</p> : null}
					<div className="reference-text">{entry.body}</div>
				</>
			) : (
				<p className="reference-text">
					{cut.text}
					{cut.truncated ? '…' : ''}
				</p>
			)}
			<button onClick={open}>{full ? zh.openMiddle : zh.openEntry}</button>
		</article>
	);
}
