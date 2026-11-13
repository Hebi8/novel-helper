import { ipcMain } from 'electron';
import { channels, type BuoyAction, type ReportKind } from '../../shared/api';
import type { FieldValue } from '../../core/frontmatter';
import type { MainContext } from '../context';
import { bookPath } from '../book/paths';
import { createLore, openCompanion, quickItems, referenceData, setLoreField } from './service';
export function registerReference(ctx: MainContext): void {
	ipcMain.handle(channels.referenceGet, (event) => referenceData(ctx.bookFor(event)!));
	ipcMain.handle(channels.loreSet, (event, path: string, field: 'always' | 'aliases' | 'type', value: FieldValue) =>
		setLoreField(ctx.bookFor(event)!, bookPath(path), field, value),
	);
	ipcMain.handle(channels.loreCreate, (event, name: string, type: string) => createLore(ctx.bookFor(event)!, name, type));
	ipcMain.handle(channels.companionOpen, (event, path: string, kind: 'outline' | 'summary') =>
		openCompanion(ctx.bookFor(event)!, bookPath(path), kind),
	);
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
	ctx.onBookClosed((root) => ctx.completion.closeBook(root));
}
