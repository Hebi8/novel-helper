import type { AppAPI, DiskFile } from '../../shared/api';
/** One open document owns its save queue, including writes completed after switching tabs. */
export class DocumentModel {
	text: string;
	base: string;
	conflict?: string;
	error?: string;
	private timer?: ReturnType<typeof setTimeout>;
	private diskRevision = 0;
	private composing = false;
	private compositionDone?: Promise<void>;
	private endComposition?: () => void;
	private readonly listeners = new Set<() => void>();
	version = 0;
	subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};
	private publish(): void {
		this.version++;
		this.onChanged();
		this.listeners.forEach((listener) => listener());
	}
	compositionStart(): void {
		this.composing = true;
		clearTimeout(this.timer);
		this.compositionDone = new Promise((resolve) => {
			this.endComposition = resolve;
		});
	}
	compositionEnd(text: string): void {
		this.composing = false;
		this.edit(text);
		this.endComposition?.();
		this.compositionDone = undefined;
	}
	private saving: Promise<void> = Promise.resolve();
	onChanged: () => void = () => {};
	constructor(
		readonly path: string,
		text: string,
		private readonly api: AppAPI,
	) {
		this.text = this.base = text;
	}
	get dirty(): boolean {
		return this.text !== this.base;
	}
	edit(text: string): void {
		this.text = text;
		clearTimeout(this.timer);
		if (!this.composing) {
			this.timer = setTimeout(() => {
				void this.save();
			}, 1000);
		}
		this.publish();
	}
	external(file: DiskFile): 'reload' | 'conflict' {
		clearTimeout(this.timer);
		this.diskRevision++;
		if (file.error) {
			this.error = file.error;
			this.publish();
			return 'conflict';
		}
		this.error = undefined;
		if (this.dirty || this.conflict !== undefined) {
			this.conflict = file.text;
			this.publish();
			return 'conflict';
		}
		this.text = this.base = file.text;
		this.publish();
		return 'reload';
	}
	save(force = false): Promise<void> {
		if (this.composing) {
			return this.compositionDone!.then(() => this.save(force));
		}
		clearTimeout(this.timer);
		this.saving = this.saving.then(async () => {
			if (this.composing) {
				await this.compositionDone;
			}
			if ((!this.dirty && !(force && this.conflict !== undefined)) || (this.conflict !== undefined && !force)) {
				return;
			}
			const text = this.text;
			const revision = this.diskRevision;
			try {
				const result = await this.api.book.save(this.path, text, this.base, force);
				if (result.saved) {
					this.base = text;
					if (revision === this.diskRevision) {
						this.conflict = undefined;
					}
					this.error = undefined;
				} else {
					this.conflict = result.disk;
				}
			} catch (error) {
				this.error = String(error);
			}
			this.publish();
		});
		return this.saving;
	}
	useDisk(): void {
		this.text = this.base = this.conflict!;
		this.conflict = undefined;
		this.publish();
	}
	dispose(): void {
		clearTimeout(this.timer);
	}
}
