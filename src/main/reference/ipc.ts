import { ipcMain } from 'electron';
import { channels, type BuoyAction, type ReportKind } from '../../shared/api';
import type { FieldValue } from '../../core/frontmatter';
import type { MainContext } from '../context';
import { bookPath } from '../book/paths';
import { createLore, openCompanion, quickItems, referenceData, setLoreField } from './service';
import { onAssistantReverted, onAssistantTurnEnded } from '../assistant/events';
export function registerReference(ctx: MainContext): void {
	ipcMain.handle(channels.referenceGet, (event) => referenceData(ctx.bookFor(event)!));
	ipcMain.handle(channels.loreSet, (event, path: string, field: 'always' | 'aliases' | 'type', value: FieldValue) => {
		const book = ctx.bookFor(event)!;
		return ctx.snapshots.write(book.root, () => setLoreField(book, bookPath(path), field, value));
	});
	ipcMain.handle(channels.loreCreate, (event, name: string, type: string) => {
		const book = ctx.bookFor(event)!;
		return ctx.snapshots.write(book.root, () => createLore(book, name, type));
	});
	ipcMain.handle(channels.companionOpen, (event, path: string, kind: 'outline' | 'summary') => {
		const book = ctx.bookFor(event)!;
		return ctx.snapshots.write(book.root, () => openCompanion(book, bookPath(path), kind));
	});
	ipcMain.handle(channels.quickOpen, (event) => quickItems(ctx.bookFor(event)!));
	ipcMain.handle(channels.buoyGet, (event, chapter: string, text?: string) =>
		ctx.completion.buoys(ctx.bookFor(event)!).status(bookPath(chapter), text),
	);
	ipcMain.handle(channels.buoyAction, (event, chapter: string, action: BuoyAction, node?: string) =>
		ctx.completion.buoys(ctx.bookFor(event)!).act(bookPath(chapter), action, node),
	);
	ipcMain.handle(channels.reportGet, (event, kind: ReportKind) => ctx.completion.report(String(event.sender.id), kind));
	ctx.completion.onPositionChanged = (root) => ctx.broadcast(channels.buoyChanged, root);
	ctx.completion.onReportChanged = () => ctx.broadcast(channels.reportChanged, undefined);
	// The assistant and going back to a snapshot write buoy files directly, so what is shown of them is read again.
	onAssistantTurnEnded(({ root }) => ctx.broadcast(channels.buoyChanged, root));
	onAssistantReverted(({ root }) => ctx.broadcast(channels.buoyChanged, root));
	ctx.onBookClosed((root) => ctx.completion.closeBook(root));
}
