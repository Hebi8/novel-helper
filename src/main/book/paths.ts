import { isAbsolute } from 'node:path';
import { leadsOut } from '../../core/story';
import { zh } from '../../renderer/strings';
export function bookPath(path: string): string {
	if (leadsOut(path) || isAbsolute(path)) {
		throw new Error(zh.outsideBook);
	}
	return path;
}
