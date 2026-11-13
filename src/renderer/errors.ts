/** Keep the explanation while removing Electron's transport wrapper. */
export function errorMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.replace(/^(?:Error: |Error invoking remote method '[^']+': )+/, '');
}
