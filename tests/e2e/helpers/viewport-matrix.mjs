import { VIEWPORT_MATRIX, viewportContextOptions } from "./e2e-session.mjs";

export { VIEWPORT_MATRIX, viewportContextOptions };

export const IPAD_VIEWPORT_KEYS = [
	"VP-SM-PORT",
	"VP-SM-LAND",
	"VP-MD-PORT",
	"VP-MD-LAND",
	"VP-LG-PORT",
	"VP-LG-LAND",
	"VP-SPLIT-1",
	"VP-SPLIT-2",
];

export const DESKTOP_VIEWPORT_KEY = "VP-DESK-REF";

export const ALL_VIEWPORT_KEYS = [...IPAD_VIEWPORT_KEYS, DESKTOP_VIEWPORT_KEY];

export const EXTREME_SPLIT_VIEWPORT = {
	width: 320,
	height: 1024,
	hasTouch: true,
	isMobile: true,
	deviceScaleFactor: 2,
};

export const VIEWPORT_LABELS = {
	"VP-SM-PORT": "Small iPad Portrait (744x1133 CSS px)",
	"VP-SM-LAND": "Small iPad Landscape (1133x744 CSS px)",
	"VP-MD-PORT": "Medium iPad Portrait (820x1180 CSS px)",
	"VP-MD-LAND": "Medium iPad Landscape (1180x820 CSS px)",
	"VP-LG-PORT": "Large iPad Portrait (1024x1366 CSS px)",
	"VP-LG-LAND": "Large iPad Landscape (1366x1024 CSS px)",
	"VP-SPLIT-1": "iPad Narrow Split-View 1/3 (375x1024 CSS px)",
	"VP-SPLIT-2": "iPad Medium Split-View 1/2 (507x1180 CSS px)",
	"VP-DESK-REF": "Desktop Reference (1440x900 CSS px)",
};

export function getViewportPreset(key) {
	if (typeof key !== "string" || !Object.prototype.hasOwnProperty.call(VIEWPORT_MATRIX, key)) {
		throw new Error(`Unknown viewport preset key: ${String(key)}`);
	}
	return { key, ...VIEWPORT_MATRIX[key] };
}

export async function applyViewport(page, keyOrPreset) {
	const vp = typeof keyOrPreset === "string" ? getViewportPreset(keyOrPreset) : keyOrPreset;
	if (!vp || !Number.isFinite(vp.width) || !Number.isFinite(vp.height)) {
		throw new Error(`Invalid viewport preset: ${String(keyOrPreset)}`);
	}
	await page.setViewportSize({ width: vp.width, height: vp.height });
	// Wait two animation frames so WebKit finishes post-resize reflow before geometry assertions.
	await page.evaluate(
		() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
	);
	return vp;
}

export function formatViewportLabel(key) {
	if (typeof key === "string") {
		if (Object.prototype.hasOwnProperty.call(VIEWPORT_LABELS, key)) {
			return VIEWPORT_LABELS[key];
		}
		const vp = getViewportPreset(key);
		return `${key} (${vp.width}x${vp.height} CSS px)`;
	}
	if (key && typeof key === "object" && Number.isFinite(key.width) && Number.isFinite(key.height)) {
		return `${key.width}x${key.height} CSS px`;
	}
	throw new Error(`Invalid viewport key or preset: ${String(key)}`);
}

export function formatViewportSummary(keys = ALL_VIEWPORT_KEYS) {
	return keys
		.map((key) => {
			const vp = getViewportPreset(key);
			const label = formatViewportLabel(key);
			return `${key}: ${vp.width}x${vp.height} CSS px (touch=${vp.hasTouch}, mobile=${vp.isMobile}, dpr=${vp.deviceScaleFactor}) — ${label}`;
		})
		.join("\n");
}
