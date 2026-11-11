// Minimal Server-Sent Events reader over a fetch response body.

export interface SseEvent {
	event?: string;
	data: string;
}

export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
	const decoder = new TextDecoder('utf-8');
	let buffer = '';
	let event: string | undefined;
	let data: string[] = [];

	function* takeLines(flush: boolean): Generator<SseEvent> {
		let newline: number;
		while ((newline = buffer.search(/\r\n|\r|\n/)) !== -1) {
			// A trailing \r may be the first half of \r\n: wait for the next chunk.
			if (!flush && buffer[newline] === '\r' && newline === buffer.length - 1) {
				return;
			}
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + (buffer.startsWith('\r\n', newline) ? 2 : 1));
			if (line === '') {
				if (data.length) {
					yield { event, data: data.join('\n') };
				}
				event = undefined;
				data = [];
			} else if (!line.startsWith(':')) {
				const colon = line.indexOf(':');
				const field = colon === -1 ? line : line.slice(0, colon);
				const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
				if (field === 'data') {
					data.push(value);
				} else if (field === 'event') {
					event = value;
				}
			}
		}
	}

	const reader = body.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			buffer += decoder.decode(value, { stream: true });
			yield* takeLines(false);
		}
		buffer += decoder.decode();
		if (buffer) {
			// The stream ended mid-line: that line is complete.
			buffer += '\n';
		}
		yield* takeLines(true);
		if (data.length) {
			yield { event, data: data.join('\n') };
		}
	} finally {
		reader.releaseLock();
	}
}
