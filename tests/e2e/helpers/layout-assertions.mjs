import { expect } from "@playwright/test";
import {
	assertNoHorizontalOverflow,
	assertPopoversInViewport,
	assertTouchTargets,
} from "./e2e-session.mjs";

export { assertNoHorizontalOverflow, assertPopoversInViewport, assertTouchTargets };

export async function assertElementsInViewport(page, selectors) {
	if (!Array.isArray(selectors)) {
		throw new TypeError("assertElementsInViewport expects an array of selectors");
	}
	const failures = await page.evaluate((sels) => {
		const out = [];
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		for (const sel of sels) {
			const matches = Array.from(document.querySelectorAll(sel));
			const visible = matches.filter((el) => {
				const style = getComputedStyle(el);
				if (style.display === "none" || style.visibility === "hidden") return false;
				const r = el.getBoundingClientRect();
				return r.width > 0 && r.height > 0;
			});
			if (visible.length === 0) {
				out.push({ selector: sel, reason: "missing-or-hidden" });
				continue;
			}
			for (let idx = 0; idx < visible.length; idx++) {
				const r = visible[idx].getBoundingClientRect();
				if (r.left < -1 || r.top < -1 || r.right > vw + 1 || r.bottom > vh + 1) {
					out.push({
						selector: sel,
						index: idx,
						reason: "out-of-viewport",
						rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
						viewport: { width: vw, height: vh },
					});
				}
			}
		}
		return out;
	}, selectors);
	expect(failures).toEqual([]);
}

export async function assertElementUnoccluded(page, selector) {
	const locator = typeof selector === "string" ? page.locator(selector).first() : selector;
	await expect(locator).toBeVisible();
	const result = await locator.evaluate((el) => {
		const style = getComputedStyle(el);
		if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
			return { ok: false, reason: "hidden" };
		}
		const r = el.getBoundingClientRect();
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		if (r.width <= 0 || r.height <= 0) {
			return { ok: false, reason: "zero-size" };
		}
		if (r.left < -1 || r.top < -1 || r.right > vw + 1 || r.bottom > vh + 1) {
			return {
				ok: false,
				reason: "out-of-viewport",
				rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
				viewport: { width: vw, height: vh },
			};
		}
		const cx = Math.min(Math.max(r.left + r.width / 2, 0), Math.max(0, vw - 1));
		const cy = Math.min(Math.max(r.top + r.height / 2, 0), Math.max(0, vh - 1));
		const hit = document.elementFromPoint(cx, cy);
		if (!hit) {
			return { ok: false, reason: "no-element-at-point", point: { cx, cy } };
		}
		const isSelfOrDescendant = hit === el || el.contains(hit);
		const isAssociatedLabel =
			"labels" in el &&
			el.labels != null &&
			Array.from(el.labels).some((lbl) => lbl === hit || lbl.contains(hit));
		if (!isSelfOrDescendant && !isAssociatedLabel) {
			return {
				ok: false,
				reason: "occluded",
				point: { cx, cy },
				hitTag: hit.tagName,
				hitTestId: hit.getAttribute("data-testid") || null,
				hitClass: typeof hit.className === "string" ? hit.className : null,
			};
		}
		return { ok: true };
	});
	expect(result).toEqual({ ok: true });
}

export async function assertClosedSidebarNotOverlapping(
	page,
	{ sidebarSelector = "aside", mainSelector = "main" } = {},
) {
	const result = await page.evaluate(
		({ sSel, mSel }) => {
			const sidebar = document.querySelector(sSel);
			const main = document.querySelector(mSel);
			const vw = window.innerWidth;
			const issues = [];

			let mainRect = null;
			if (main) {
				mainRect = main.getBoundingClientRect();
				if (mainRect.width < 240) {
					issues.push({ reason: "main-squeezed", width: mainRect.width });
				}
			}

			if (sidebar) {
				const style = getComputedStyle(sidebar);
				const rect = sidebar.getBoundingClientRect();
				const isHidden =
					style.display === "none" ||
					style.visibility === "hidden" ||
					sidebar.getAttribute("aria-hidden") === "true" ||
					rect.width <= 1 ||
					rect.height <= 1 ||
					rect.right <= 1 ||
					rect.left >= vw - 1;

				if (!isHidden) {
					const overlapsMain =
						mainRect &&
						!(
							rect.right <= mainRect.left + 1 ||
							rect.left >= mainRect.right - 1 ||
							rect.bottom <= mainRect.top + 1 ||
							rect.top >= mainRect.bottom - 1
						);
					issues.push({
						reason: overlapsMain ? "closed-sidebar-overlaps-main" : "closed-sidebar-still-visible",
						sidebarRect: { left: rect.left, right: rect.right, width: rect.width },
						mainRect: mainRect ? { left: mainRect.left, right: mainRect.right, width: mainRect.width } : null,
					});
				}
			}
			return issues;
		},
		{ sSel: sidebarSelector, mSel: mainSelector },
	);
	expect(result).toEqual([]);
}

export async function simulateVisualViewportResize(page, newHeight) {
	if (!Number.isFinite(newHeight) || newHeight <= 0) {
		throw new Error(`Invalid visualViewport target height: ${String(newHeight)}`);
	}
	const state = await page.evaluate((targetH) => {
		const initialInnerHeight = window.innerHeight;
		let visualViewportHeight = null;
		if (window.visualViewport) {
			if (!Object.prototype.hasOwnProperty.call(window, "__lhOrigVvHeightDesc")) {
				const ownDesc = Object.getOwnPropertyDescriptor(window.visualViewport, "height") || null;
				Object.defineProperty(window, "__lhOrigVvHeightDesc", {
					configurable: true,
					writable: true,
					value: ownDesc,
				});
			}
			Object.defineProperty(window.visualViewport, "height", {
				configurable: true,
				get: () => targetH,
			});
			window.visualViewport.dispatchEvent(new Event("resize"));
			visualViewportHeight = window.visualViewport.height;
		}
		return {
			initialInnerHeight,
			afterInnerHeight: window.innerHeight,
			visualViewportHeight,
		};
	}, newHeight);

	async function restore() {
		if (page.isClosed()) return;
		await page.evaluate(() => {
			if (!window.visualViewport) return;
			const origDesc = window.__lhOrigVvHeightDesc;
			if (origDesc) {
				Object.defineProperty(window.visualViewport, "height", origDesc);
			} else {
				delete window.visualViewport.height;
			}
			delete window.__lhOrigVvHeightDesc;
			window.visualViewport.dispatchEvent(new Event("resize"));
		});
	}

	return { ...state, restore };
}

export async function simulateOnscreenKeyboard(page, keyboardHeightPx = 360) {
	if (!Number.isFinite(keyboardHeightPx) || keyboardHeightPx < 0) {
		throw new Error(`Invalid keyboardHeightPx: ${String(keyboardHeightPx)}`);
	}
	const targetHeight = await page.evaluate(
		(kbHeight) => Math.max(120, window.innerHeight - kbHeight),
		keyboardHeightPx,
	);
	const { restore, visualViewportHeight, initialInnerHeight, afterInnerHeight } =
		await simulateVisualViewportResize(page, targetHeight);
	restore.visualViewportHeight = visualViewportHeight;
	restore.initialInnerHeight = initialInnerHeight;
	restore.afterInnerHeight = afterInnerHeight;
	return restore;
}

export async function assertKeyboardClearance(page, targetLocator, keyboardHeightPx = 360) {
	const restore = await simulateOnscreenKeyboard(page, keyboardHeightPx);
	try {
		await targetLocator.scrollIntoViewIfNeeded();
		await expect(targetLocator).toBeVisible();
		const box = await targetLocator.boundingBox();
		expect(box).toBeTruthy();
		const vvHeight =
			restore.visualViewportHeight ??
			(await page.evaluate(() => window.visualViewport?.height ?? window.innerHeight));
		expect(box.y).toBeGreaterThanOrEqual(-1);
		expect(box.y + box.height).toBeLessThanOrEqual(vvHeight + 2);
		await assertNoHorizontalOverflow(page);
		return { box, visualViewportHeight: vvHeight };
	} finally {
		await restore();
	}
}

export async function assertScrollableContainerContained(page, containerSelector) {
	await assertNoHorizontalOverflow(page);
	const result = await page.evaluate((sel) => {
		const el = document.querySelector(sel);
		if (!el) return { ok: false, reason: "missing" };
		const rect = el.getBoundingClientRect();
		const vw = window.innerWidth;
		const style = getComputedStyle(el);
		if (rect.width <= 0 || rect.height <= 0) {
			return { ok: false, reason: "zero-size" };
		}
		if (rect.left < -1 || rect.right > vw + 1) {
			return {
				ok: false,
				reason: "container-exceeds-viewport",
				rect: { left: rect.left, right: rect.right, width: rect.width },
				viewportWidth: vw,
			};
		}
		if (el.scrollWidth > el.clientWidth + 1) {
			const ox = style.overflowX;
			if (ox !== "auto" && ox !== "scroll" && ox !== "hidden" && ox !== "clip") {
				return {
					ok: false,
					reason: "uncontained-overflow-x",
					overflowX: ox,
					scrollWidth: el.scrollWidth,
					clientWidth: el.clientWidth,
				};
			}
		}
		return { ok: true };
	}, containerSelector);
	expect(result).toEqual({ ok: true });
}

export async function assertResponsiveShell(
	page,
	{ touchSelectors = [], checkPopovers = false, inViewportSelectors = [] } = {},
) {
	await assertNoHorizontalOverflow(page);
	if (checkPopovers) {
		await assertPopoversInViewport(page);
	}
	if (touchSelectors.length > 0) {
		await assertTouchTargets(page, touchSelectors);
	}
	if (inViewportSelectors.length > 0) {
		await assertElementsInViewport(page, inViewportSelectors);
	}
}
