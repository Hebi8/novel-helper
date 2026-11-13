import { useEffect, useState, useRef } from 'react';
import type { Book, BuoyStatus, ReferenceData } from '../../shared/api';
import { errorMessage } from '../errors';
const empty: ReferenceData = { entries: [], nodes: [], outlines: [] };
export function useReferences(
	book: Book | undefined,
	chapter: string | undefined,
	text: () => string | undefined,
	fail: (message: string) => void,
) {
	const currentText = useRef(text);
	currentText.current = text;
	const [reference, setReference] = useState(empty);
	const [buoy, setBuoy] = useState<BuoyStatus>();
	useEffect(() => {
		if (!book) {
			return;
		}
		let alive = true;
		void window.novel.reference
			.get()
			.then((data) => {
				if (alive) {
					setReference(data);
				}
			})
			.catch((error) => {
				if (alive) {
					fail(errorMessage(error));
				}
			});
		return () => {
			alive = false;
		};
	}, [book]);
	useEffect(() => {
		if (!book || !chapter) {
			setBuoy(undefined);
			return;
		}
		let version = 0;
		const refresh = () => {
			const current = ++version;
			void window.novel.buoys
				.get(chapter, currentText.current())
				.then((data) => {
					if (current === version) {
						setBuoy(data);
					}
				})
				.catch((error) => {
					if (current === version) {
						fail(errorMessage(error));
					}
				});
		};
		refresh();
		const stop = window.novel.buoys.onChanged((root) => {
			if (root === book.root) {
				refresh();
			}
		});
		return () => {
			version++;
			stop();
		};
	}, [book, chapter]);
	return { reference, buoy };
}
