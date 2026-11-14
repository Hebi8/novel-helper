import type { AssistantService } from './service';

/** A reopened book waits for its previous window's final snapshot and transcript. */
export class AssistantRegistry {
	private readonly live = new Map<string, Promise<AssistantService>>();
	private readonly closing = new Map<string, Promise<void>>();
	private readonly started = new Map<string, AssistantService>();
	get(root: string, create: () => Promise<AssistantService>): Promise<AssistantService> {
		let pending = this.live.get(root);
		if (!pending) {
			const opening = (this.closing.get(root) ?? Promise.resolve()).then(create);
			pending = opening;
			this.live.set(root, opening);
			void opening.then(
				(service) => {
					if (this.live.get(root) === opening) {
						this.started.set(root, service);
					}
				},
				() => undefined,
			);
		}
		return pending;
	}
	close(root: string): Promise<void> {
		const service = this.live.get(root);
		this.live.delete(root);
		this.started.delete(root);
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
	/** Answers at once: a snapshot queued by the old window must not wait for the reopened one, which itself waits for the old window to close. */
	busy(root: string): boolean {
		return this.started.get(root)?.state().busy ?? false;
	}
	async each(visit: (service: AssistantService) => void): Promise<void> {
		for (const pending of this.live.values()) {
			visit(await pending);
		}
	}
	async closeAll(): Promise<void> {
		await Promise.all([...this.live.keys()].map((root) => this.close(root)).concat([...this.closing.values()]));
	}
}
