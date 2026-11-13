import { errorMessage } from '../errors';
import type { OpenResult } from '../../shared/api';
import { zh } from '../strings';
export function Welcome({
	recent,
	result,
	open,
	dismiss,
}: {
	recent: string[];
	result?: OpenResult;
	open(root?: string): void;
	dismiss(): void;
}) {
	return (
		<main className="welcome">
			<h1>{zh.app}</h1>
			{result?.kind === 'error' ? (
				<p role="alert">
					{errorMessage(result.message)}
					<button onClick={dismiss}>{zh.dismiss}</button>
				</p>
			) : null}
			<button className="open-folder" onClick={() => open()}>
				{zh.openFolder}
			</button>
			<button className="open-folder" onClick={() => open()}>
				{zh.newBook}
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
