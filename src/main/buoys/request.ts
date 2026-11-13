import { complete, type Answer, type ModelRequest } from '../../llm/client';
/** Use the cancellable transport and keep its raw reply for the position parser. */
export async function askPosition(request: ModelRequest, signal: AbortSignal): Promise<Answer> {
	let usage: Answer['usage'];
	let closed!: () => void;
	const connection = new Promise<void>((resolve) => {
		closed = resolve;
	});
	const outcome = await complete(request, {
		signal,
		before: '',
		after: '',
		maxChars: Infinity,
		onUsage: (value) => {
			usage = value;
		},
		onClose: closed,
	});
	await connection;
	return { text: outcome.raw, usage, error: outcome.error };
}
