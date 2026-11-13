import type { OpenResult } from '../../shared/api';
import { zh } from '../strings';
export function Welcome({ recent, result, open }: { recent: string[]; result?: OpenResult; open(root?: string): void }) {
	return (
		<main className="welcome">
			<h1>{zh.app}</h1>
			<button className="open-folder" onClick={() => open()}>
				{zh.openFolder}
			</button>
			{recent.length ? (
				<section>
					<h2>{zh.recent}</h2>
					{recent.map((root) => (
						<button key={root} onClick={() => open(root)}>
							{root.split('/').pop()}
						</button>
					))}
				</section>
			) : null}
			{result?.kind === 'choices' ? (
				<section>
					<h2>{zh.chooseStory}</h2>
					{result.roots.map((root) => (
						<button key={root} onClick={() => open(root)}>
							{root}
						</button>
					))}
				</section>
			) : result?.kind === 'empty' ? (
				<p>{zh.empty}</p>
			) : null}
		</main>
	);
}
