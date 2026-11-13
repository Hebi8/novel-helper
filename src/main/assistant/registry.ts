import type { AssistantService } from './service';

/** A reopened book waits for its previous window's final snapshot and transcript. */
export class AssistantRegistry {
	private readonly live = new Map<string, Promise<AssistantService>>();
	private readonly closing = new Map<string, Promise<void>>();
	get(root: string, create: () => Promise<AssistantService>): Promise<AssistantService> {
		let pending = this.live.get(root);
		if (!pending) {
			pending = (this.closing.get(root) ?? Promise.resolve()).then(create);
			this.live.set(root, pending);
		}
		return pending;
	}
	close(root: string): Promise<void> {
		const service = this.live.get(root);
		this.live.delete(root);
		if (!service) {
			return this.closing.get(root) ?? Promise.resolve();
		}
		const pending = service
			.then((service) => service.dispose())
			.finally(() => {
				if (this.closing.get(root) === pending) {
					this.closing.delete(root);
				}
			});
		this.closing.set(root, pending);
		return pending;
	}
	async busy(root: string): Promise<boolean> {
		return (await this.live.get(root))?.state().busy ?? false;
	}
	async closeAll(): Promise<void> {
		await Promise.all([...this.live.keys()].map((root) => this.close(root)).concat([...this.closing.values()]));
	}
}
