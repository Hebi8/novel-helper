import { useEffect, useState } from 'react';
import { errorMessage } from '../errors';
import type { OpenResult } from '../../shared/api';
import { zh } from '../strings';
export function Welcome({
	ready = false,
	recent,
	initialICloudBooks = [],
	result,
	open,
	dismiss,
}: {
	ready?: boolean;
	recent: string[];
	initialICloudBooks?: string[];
	result?: OpenResult;
	open(root?: string, selected?: boolean): void;
	dismiss(): void;
}) {
	const [icloudBooks, setICloudBooks] = useState<string[]>(initialICloudBooks);
	useEffect(() => {
		setICloudBooks(initialICloudBooks);
	}, [initialICloudBooks]);
	useEffect(() => {
		if (!ready) {
			return;
		}
		let alive = true;
		const unsubscribe = window.novel.book.onICloudChanged((books) => {
			if (alive) {
				setICloudBooks(books);
			}
		});
		void window.novel.book.watchICloud().then((books) => {
			if (alive) {
				setICloudBooks(books);
			}
		});
		return () => {
			alive = false;
			unsubscribe();
			window.novel.book.unwatchICloud();
		};
	}, [ready]);
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
				<section aria-label={zh.recent}>
					<h2>{zh.recent}</h2>
					{recent.map((root) => (
						<button key={root} onClick={() => open(root)}>
							{root.split('/').pop()}
						</button>
					))}
				</section>
			) : null}
			{icloudBooks.length ? (
				<section aria-label={zh.icloudBooks}>
					<h2>{zh.icloudBooks}</h2>
					{icloudBooks.map((root) => (
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
						<button key={root} onClick={() => open(root, true)}>
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
