import { expect } from "@playwright/test";
import { analyzePngPixels, assertPngContrast } from "./test-assets.mjs";

export { analyzePngPixels, assertPngContrast };

export function drawingCanvas(page) {
	return page.locator("canvas.drawing-pad-ink");
}

export async function drawCanvasStroke(
	page,
	canvasLocator,
	{ pointerType = "pen", points, pressure = 0.7, pointerId = 1 } = {},
) {
	if (!Array.isArray(points) || points.length === 0) {
		throw new Error("drawCanvasStroke requires a non-empty points array");
	}
	const box = await canvasLocator.boundingBox();
	expect(box).toBeTruthy();
	await canvasLocator.evaluate(
		(canvas, { pType, pts, rect, strokePressure, pId }) => {
			const abs = pts.map(([rx, ry]) => ({
				clientX: rect.x + rx * rect.width,
				clientY: rect.y + ry * rect.height,
			}));
			const makeEvt = (type, pt, buttons, press) =>
				new PointerEvent(type, {
					pointerId: pId,
					pointerType: pType,
					isPrimary: true,
					clientX: pt.clientX,
					clientY: pt.clientY,
					pressure: press,
					buttons,
					bubbles: true,
					cancelable: true,
				});
			canvas.dispatchEvent(makeEvt("pointerdown", abs[0], 1, strokePressure));
			for (let i = 1; i < abs.length; i++) {
				canvas.dispatchEvent(makeEvt("pointermove", abs[i], 1, strokePressure));
			}
			canvas.dispatchEvent(makeEvt("pointerup", abs[abs.length - 1], 0, 0));
		},
		{ pType: pointerType, pts: points, rect: box, strokePressure: pressure, pId: pointerId },
	);
}

export async function assertCanvasTouchActionNone(canvasLocator) {
	const touchAction = await canvasLocator.evaluate((c) => getComputedStyle(c).touchAction);
	expect(touchAction).toBe("none");
}

export async function getCanvasSnapshot(canvasLocator) {
	const dataUrl = await canvasLocator.evaluate((c) => c.toDataURL("image/png"));
	const match = /^data:image\/png;base64,(.+)$/i.exec(dataUrl);
	if (!match) {
		throw new Error(`Expected PNG data URL from canvas, got: ${String(dataUrl).slice(0, 64)}`);
	}
	return {
		dataUrl,
		buffer: Buffer.from(match[1], "base64"),
	};
}

export async function assertCleanCanvasComparedTo(canvasLocator, previousDataUrl) {
	const snapshot = await getCanvasSnapshot(canvasLocator);
	const stats = analyzePngPixels(snapshot.buffer);
	expect(stats.strokePixelCount).toBe(0);
	if (typeof previousDataUrl === "string" && previousDataUrl.length > 0) {
		const prevMatch = /^data:image\/png;base64,(.+)$/i.exec(previousDataUrl);
		if (prevMatch) {
			const prevStats = analyzePngPixels(Buffer.from(prevMatch[1], "base64"));
			if (prevStats.strokePixelCount > 0) {
				expect(snapshot.dataUrl).not.toBe(previousDataUrl);
			}
		} else {
			expect(snapshot.dataUrl).not.toBe(previousDataUrl);
		}
	}
	return { ...snapshot, stats };
}

export async function dispatchClipboardPaste(
	locator,
	{ pngBuffer, text, html, filename = "clipboard-screenshot.png" } = {},
) {
	const b64 = pngBuffer ? Buffer.from(pngBuffer).toString("base64") : null;
	await locator.evaluate(
		(el, { base64, plainText, htmlText, fileName }) => {
			el.focus();
			const dt = new DataTransfer();
			if (base64) {
				const bin = atob(base64);
				const bytes = new Uint8Array(bin.length);
				for (let i = 0; i < bin.length; i++) {
					bytes[i] = bin.charCodeAt(i);
				}
				const file = new File([bytes], fileName, { type: "image/png" });
				dt.items.add(file);
			}
			if (plainText !== undefined) {
				dt.setData("text/plain", plainText);
			}
			if (htmlText !== undefined) {
				dt.setData("text/html", htmlText);
			}
			const evt = new ClipboardEvent("paste", {
				clipboardData: dt,
				bubbles: true,
				cancelable: true,
			});
			el.dispatchEvent(evt);
		},
		{ base64: b64, plainText: text, htmlText: html, fileName: filename },
	);
}

export async function extractImageBuffer(page, imgLocator, baseUrl) {
	const src = await imgLocator.getAttribute("src");
	expect(src).toBeTruthy();

	if (src.startsWith("data:")) {
		const match = /^data:[^;]+;base64,(.+)$/i.exec(src);
		expect(match).toBeTruthy();
		return Buffer.from(match[1], "base64");
	}

	if (src.startsWith("blob:")) {
		const b64 = await page.evaluate(async (blobUrl) => {
			const res = await fetch(blobUrl);
			const buf = new Uint8Array(await res.arrayBuffer());
			let bin = "";
			for (let i = 0; i < buf.length; i++) {
				bin += String.fromCharCode(buf[i]);
			}
			return btoa(bin);
		}, src);
		return Buffer.from(b64, "base64");
	}

	const resolvedUrl = baseUrl ? new URL(src, baseUrl).toString() : src;
	const resp = await page.request.get(resolvedUrl);
	expect(resp.status()).toBe(200);
	return await resp.body();
}

export async function assertExportedDrawingContrast(page, baseUrl, imgLocator, contrastOpts = {}) {
	const buffer = await extractImageBuffer(page, imgLocator, baseUrl);
	return assertPngContrast(buffer, contrastOpts);
}

async function drawingPadSurfaceOrPage(page) {
	const surface = page.locator("[data-plugin-session-surface-frame]").filter({ has: drawingCanvas(page) }).first();
	if (await surface.isVisible().catch(() => false)) {
		return surface;
	}
	return page;
}

export async function openDrawingPad(page) {
	const trigger = page
		.locator('[data-plugin-action="drawing-pad/draw"]')
		.or(page.getByRole("button", { name: /^Draw(\s*\(unsent\))?$/i }))
		.first();
	await trigger.click();
	const canvas = drawingCanvas(page);
	await expect(canvas).toBeVisible();
	return canvas;
}

export async function closeDrawingPad(page) {
	const scope = await drawingPadSurfaceOrPage(page);
	await scope.getByRole("button", { name: /Close|×/i }).first().click();
}

export async function toggleKarorasterGrid(page) {
	const scope = await drawingPadSurfaceOrPage(page);
	await scope.getByRole("button", { name: /grid|karo/i }).first().click();
}

export async function toggleQuestionContext(page) {
	const scope = await drawingPadSurfaceOrPage(page);
	await scope.getByRole("button", { name: /question/i }).first().click();
}

export async function setPaperTheme(page, theme) {
	const scope = await drawingPadSurfaceOrPage(page);
	const patterns = {
		light: /\blight\b/i,
		dark: /\bdark\b/i,
		app: /\bapp(\s*(default|theme))?\b/i,
	};
	const pattern = patterns[String(theme).toLowerCase()];
	if (!pattern) {
		throw new Error(`Invalid drawing pad paper theme: ${String(theme)}`);
	}
	await scope.getByRole("button", { name: pattern }).first().click();
}

export async function selectDrawingTool(page, tool) {
	const scope = await drawingPadSurfaceOrPage(page);
	const patterns = {
		pen: /\bpen\b/i,
		eraser: /\beraser\b/i,
		hand: /\bhand\b/i,
		undo: /\bundo\b/i,
		redo: /\bredo\b/i,
		clear: /\bclear\b/i,
	};
	const pattern = patterns[String(tool).toLowerCase()];
	if (!pattern) {
		throw new Error(`Invalid drawing pad tool: ${String(tool)}`);
	}
	await scope.getByRole("button", { name: pattern }).first().click();
}

function escapeRegExp(str) {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function selectPenColor(page, matcher = /blue|red|green|black|ink|color/i) {
	const scope = await drawingPadSurfaceOrPage(page);
	const pattern =
		matcher instanceof RegExp ? matcher : new RegExp(escapeRegExp(String(matcher)), "i");
	const btn = scope.getByRole("button", { name: pattern }).first();
	await expect(btn).toBeVisible();
	await btn.click();
}

export async function selectStrokeWidth(page, width) {
	const scope = await drawingPadSurfaceOrPage(page);
	const slider = scope.getByRole("slider", { name: /width|size|thickness|stroke/i }).first();
	if (await slider.isVisible().catch(() => false)) {
		await slider.fill(String(width ?? 8));
		return;
	}
	const pattern =
		width instanceof RegExp
			? width
			: width !== undefined && width !== null
				? new RegExp(`\\b${escapeRegExp(String(width))}(\\s*px)?\\b`, "i")
				: /thick|large|medium|thin|small|width|size|\d+\s*px/i;
	let btn = scope.getByRole("button", { name: pattern }).last();
	if (!(await btn.isVisible().catch(() => false))) {
		btn = scope.getByRole("button", { name: /thick|large|medium|width|size|\d+\s*px/i }).last();
	}
	await expect(btn).toBeVisible();
	await btn.click();
}

export async function addDrawingToAnswer(page) {
	const scope = await drawingPadSurfaceOrPage(page);
	await scope.getByRole("button", { name: /Add to answer/i }).click();
}
