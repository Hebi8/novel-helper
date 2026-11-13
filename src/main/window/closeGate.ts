/** A dead renderer cannot acknowledge a save request. */
export class CloseGate {
	private alive = true;
	private flushed = false;
	rendererGone(): void {
		this.alive = false;
	}
	acknowledge(): void {
		this.flushed = true;
	}
	needsFlush(): boolean {
		return this.alive && !this.flushed;
	}
}
