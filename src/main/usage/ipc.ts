import { app } from 'electron';
import { channels } from '../../shared/api';
import type { MainContext } from '../context';
export function registerUsage(ctx: MainContext): void {
	ctx.completion.onChanged = (status) => ctx.broadcast(channels.usageChanged, status);
	let midnight: ReturnType<typeof setTimeout>;
	const refreshDay = () => {
		const next = new Date();
		next.setHours(24, 0, 0, 0);
		midnight = setTimeout(() => {
			ctx.completion.publish();
			refreshDay();
		}, next.getTime() - Date.now());
		midnight.unref();
	};
	refreshDay();
	app.on('will-quit', () => clearTimeout(midnight));
}
