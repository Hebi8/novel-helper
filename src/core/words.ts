import { dayKey } from './usage';

function pad(n: number): string {
	return String(n).padStart(2, '0');
}

/** Local writing date (`YYYY-MM-DD`) when a day starts at `startHour` (0–23). */
export function writingDayKey(date: Date, startHour = 0): string {
	const shifted = new Date(date.getFullYear(), date.getMonth(), date.getDate() - (date.getHours() < startHour ? 1 : 0));
	return dayKey(shifted);
}

/** Local hour bucket (`YYYY-MM-DDTHH`). */
export function hourBucketKey(date: Date): string {
	return `${dayKey(date)}T${pad(date.getHours())}`;
}

/** Maps a local `YYYY-MM-DDTHH` bucket to its writing date under `startHour`. */
export function writingDayOfBucket(bucket: string, startHour = 0): string {
	const year = Number(bucket.slice(0, 4));
	const month = Number(bucket.slice(5, 7));
	const day = Number(bucket.slice(8, 10));
	const hour = Number(bucket.slice(11, 13));
	return writingDayKey(new Date(year, month - 1, day, hour), startHour);
}

/** Net words written on the writing day containing `now`. */
export function sumDayWords(hours: Readonly<Record<string, number>>, now: Date, startHour = 0): number {
	const target = writingDayKey(now, startHour);
	let total = 0;
	for (const [bucket, delta] of Object.entries(hours)) {
		if (writingDayOfBucket(bucket, startHour) === target) {
			total += delta;
		}
	}
	return total;
}

/** Drops buckets before the first day of the previous calendar month. */
export function pruneWordHours(hours: Record<string, number>, now: Date): void {
	const keepFrom = dayKey(new Date(now.getFullYear(), now.getMonth() - 1, 1));
	for (const bucket of Object.keys(hours)) {
		if (bucket.slice(0, 10) < keepFrom) {
			delete hours[bucket];
		}
	}
}
