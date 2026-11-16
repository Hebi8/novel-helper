import { zh } from '../strings';

function renderSignature(ctx: CanvasRenderingContext2D, fontSpec: string): string {
	ctx.clearRect(0, 0, 48, 40);
	ctx.font = fontSpec;
	ctx.fillStyle = '#000';
	ctx.textBaseline = 'top';
	ctx.fillText('永Ag', 2, 2);
	const data = ctx.getImageData(0, 0, 48, 40).data;
	let hash = 2166136261;
	for (let i = 3; i < data.length; i += 4) {
		hash ^= data[i];
		hash = Math.imul(hash, 16777619);
	}
	return `${ctx.measureText('永字八法AgmWi1').width.toFixed(2)}:${hash >>> 0}`;
}

export function isFontInstalled(family: string): boolean {
	if (typeof document === 'undefined') {
		return false;
	}
	const canvas = document.createElement('canvas');
	canvas.width = 48;
	canvas.height = 40;
	const ctx = canvas.getContext('2d');
	if (!ctx) {
		return false;
	}
	const sans = renderSignature(ctx, '28px sans-serif');
	const serif = renderSignature(ctx, '28px serif');
	const escaped = family.replace(/"/g, '\\"');
	const withSans = renderSignature(ctx, `28px "${escaped}", sans-serif`);
	const withSerif = renderSignature(ctx, `28px "${escaped}", serif`);
	return withSans !== sans || withSerif !== serif;
}

export interface FontOption {
	value: string;
	title: string;
}

let cachedFonts: FontOption[] | undefined;

export function availableFontOptions(): FontOption[] {
	if (cachedFonts) {
		return cachedFonts;
	}
	const options: FontOption[] = [
		{ value: 'PingFang SC', title: zh.fonts.pingfang },
		{ value: 'Songti SC', title: zh.fonts.songti },
	];
	if (isFontInstalled('Kaiti SC')) {
		options.push({ value: 'Kaiti SC', title: zh.fonts.kaiti });
	}
	const wenkai = ['LXGW WenKai', 'LXGW WenKai SC', '霞鹜文楷'].find(isFontInstalled);
	if (wenkai) {
		options.push({ value: wenkai, title: zh.fonts.wenkai });
	}
	cachedFonts = options;
	return options;
}
