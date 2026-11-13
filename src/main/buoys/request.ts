import { anthropicPart, openaiPart, buildHttpRequest, redact, type Answer, type ModelRequest } from '../../llm/client';
import { readSse } from '../../llm/sse';
import { estimateTokens, type Usage } from '../../core/usage';
/** Position replies use the raw stream, without the continuation's prose rules. */
export async function askPosition(request: ModelRequest, signal: AbortSignal): Promise<Answer> {
	if (signal.aborted) {
		return { text: '' };
	}
	const controller = new AbortController();
	const abort = () => controller.abort();
	signal.addEventListener('abort', abort, { once: true });
	const timer = setTimeout(abort, request.timeoutMs);
	const parse = request.protocol === 'anthropic' ? anthropicPart : openaiPart;
	const usage: Usage = {};
	let answered = false;
	let text = '';
	let error: string | undefined;
	try {
		const { url, headers, body } = buildHttpRequest(request);
		const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}: ${await response.text()}`);
		}
		answered = true;
		for await (const event of readSse(response.body!)) {
			const part = parse(event);
			Object.assign(usage, part.usage);
			text += part.text ?? '';
			if (part.done) {
				break;
			}
		}
	} catch (failure) {
		answered ||= controller.signal.aborted;
		error = redact(String(failure), request.apiKey);
	} finally {
		clearTimeout(timer);
		signal.removeEventListener('abort', abort);
		controller.abort();
	}
	if (answered && usage.input !== undefined && usage.output === undefined) {
		usage.output = estimateTokens(text);
		usage.outputEstimated = true;
	}
	return { text, error, usage: answered ? usage : undefined };
}
