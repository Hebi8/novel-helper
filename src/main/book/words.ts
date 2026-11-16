import { app } from 'electron';
import { join } from 'node:path';
import { channels, type WordsSnapshot } from '../../shared/api';
import { WordCountStore } from '../../storage/wordCountStore';
import type { MainContext } from '../context';
import type { BookIndex } from './indexer';

class BookWordsService {
	private store?: WordCountStore;
	private readonly tracked = new WeakSet<BookIndex>();
	private readonly active = new Map<string, BookIndex>();
	private hourTimer?: ReturnType<typeof setTimeout>;

	private getStore(): WordCountStore {
		this.store ??= new WordCountStore(join(app.getPath('userData'), 'word-counts'));
		return this.store;
	}

	ensure(index: BookIndex, ctx: MainContext): WordsSnapshot {
		const store = this.getStore();
		if (!this.tracked.has(index)) {
			this.tracked.add(index);
			this.active.set(index.root, index);
			store.openBook(index.root, index.totalChapterWords());
			index.onChanged(() => {
				store.recordTotal(index.root, index.totalChapterWords());
				this.publish(index, ctx);
			});
			ctx.onBookClosed((root) => {
				if (this.active.get(root) === index) {
					this.active.delete(root);
				}
			});
			this.scheduleHourTick(ctx);
		}
		return this.snapshot(index, ctx);
	}

	snapshot(index: BookIndex, ctx: MainContext): WordsSnapshot {
		return {
			todayWords: this.getStore().today(index.root, ctx.settings.get()['editor.dayStartHour']),
			chapterWords: index.chapterWordCounts(),
		};
	}

	publish(index: BookIndex, ctx: MainContext): void {
		ctx.broadcast(channels.wordsChanged, { root: index.root, ...this.snapshot(index, ctx) });
	}

	publishAll(ctx: MainContext): void {
		for (const index of this.active.values()) {
			this.publish(index, ctx);
		}
	}

	private scheduleHourTick(ctx: MainContext): void {
		if (this.hourTimer) {
			return;
		}
		const tick = () => {
			const next = new Date();
			next.setHours(next.getHours() + 1, 0, 0, 0);
			this.hourTimer = setTimeout(() => {
				this.publishAll(ctx);
				tick();
			}, next.getTime() - Date.now());
			this.hourTimer.unref();
		};
		tick();
		app.on('will-quit', () => clearTimeout(this.hourTimer));
	}
}

export const bookWords = new BookWordsService();
