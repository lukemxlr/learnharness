import path from "node:path";
import { expect } from "@playwright/test";
import { startMockProvider } from "../harness/mock-provider.mjs";
import { resolveRepoDir, ServerController } from "../harness/server-controller.mjs";

export const DEFAULT_USER = {
	username: "synthlearner",
	password: "SynthPassword123!",
};

export const VIEWPORT_MATRIX = {
	"VP-SM-PORT": { width: 744, height: 1133, hasTouch: true, isMobile: true, deviceScaleFactor: 2 },
	"VP-SM-LAND": { width: 1133, height: 744, hasTouch: true, isMobile: true, deviceScaleFactor: 2 },
	"VP-MD-PORT": { width: 820, height: 1180, hasTouch: true, isMobile: true, deviceScaleFactor: 2 },
	"VP-MD-LAND": { width: 1180, height: 820, hasTouch: true, isMobile: true, deviceScaleFactor: 2 },
	"VP-LG-PORT": { width: 1024, height: 1366, hasTouch: true, isMobile: true, deviceScaleFactor: 2 },
	"VP-LG-LAND": { width: 1366, height: 1024, hasTouch: true, isMobile: true, deviceScaleFactor: 2 },
	"VP-SPLIT-1": { width: 375, height: 1024, hasTouch: true, isMobile: true, deviceScaleFactor: 2 },
	"VP-SPLIT-2": { width: 507, height: 1180, hasTouch: true, isMobile: true, deviceScaleFactor: 2 },
	"VP-DESK-REF": { width: 1440, height: 900, hasTouch: false, isMobile: false, deviceScaleFactor: 1 },
};

export function viewportContextOptions(keyOrPreset) {
	const vp = typeof keyOrPreset === "string" ? VIEWPORT_MATRIX[keyOrPreset] : keyOrPreset;
	if (!vp) {
		throw new Error(`Unknown viewport preset: ${keyOrPreset}`);
	}
	return {
		viewport: { width: vp.width, height: vp.height },
		hasTouch: vp.hasTouch,
		isMobile: vp.isMobile,
		deviceScaleFactor: vp.deviceScaleFactor,
	};
}

export function syntheticFixtureDir() {
	return path.join(resolveRepoDir(), "tests", "fixtures", "e2e-synthetic");
}

export async function bootStack(options = {}) {
	const mock = await startMockProvider(options.mockOptions);
	const ctrl = new ServerController(options.serverOptions);
	try {
		if (options.seedProfile !== false) {
			ctrl.seedSyntheticProfile(syntheticFixtureDir(), { mockBaseUrl: mock.baseUrl });
		}
		if (options.initAuth !== false) {
			await ctrl.initAuth({
				username: options.username || DEFAULT_USER.username,
				password: options.password || DEFAULT_USER.password,
			});
		}
		const { baseUrl, port } = await ctrl.start(options.startOptions || {});
		return {
			mock,
			ctrl,
			baseUrl,
			port,
			async cleanup() {
				await ctrl.cleanup();
				await mock.close();
			},
		};
	} catch (err) {
		await ctrl.cleanup().catch(() => {});
		await mock.close().catch(() => {});
		throw err;
	}
}

export async function loginApi(
	baseUrl,
	{ username = DEFAULT_USER.username, password = DEFAULT_USER.password, headers = {} } = {},
) {
	const res = await fetch(`${baseUrl}/api/auth/login`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...headers,
		},
		body: JSON.stringify({ username, password }),
	});
	const setCookie = res.headers.get("set-cookie") || "";
	const match = /lh_session=([^;]+)/.exec(setCookie);
	const cookie = match ? `lh_session=${match[1]}` : "";
	return { res, cookie, setCookie };
}

export async function loginBrowser(
	page,
	baseUrl,
	{ username = DEFAULT_USER.username, password = DEFAULT_USER.password } = {},
) {
	await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
	await expect(page).toHaveURL(/\/login/);
	await page.getByTestId("login-username").fill(username);
	await page.getByTestId("login-password").fill(password);
	await page.getByTestId("login-submit").click();
	await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 15_000 });
}

export async function createChatSession(baseUrl, cookie, body = {}) {
	const res = await fetch(`${baseUrl}/api/chats`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Cookie: cookie,
		},
		body: JSON.stringify(body),
	});
	expect(res.status).toBe(200);
	return res.json();
}

export async function assertNoHorizontalOverflow(page) {
	const dims = await page.evaluate(() => ({
		scrollWidth: document.documentElement.scrollWidth,
		clientWidth: document.documentElement.clientWidth,
	}));
	expect(dims.scrollWidth).toBeLessThanOrEqual(dims.clientWidth);
}

export async function assertPopoversInViewport(page) {
	const clipped = await page.evaluate(() => {
		const selectors = [
			'[role="menu"]',
			'[data-lh-menu]',
			'[data-testid="model-menu"]',
			'[data-testid="thinking-menu"]',
		];
		const issues = [];
		for (const sel of selectors) {
			for (const el of document.querySelectorAll(sel)) {
				const rect = el.getBoundingClientRect();
				if (rect.width === 0 && rect.height === 0) continue;
				if (
					rect.left < -1 ||
					rect.top < -1 ||
					rect.right > window.innerWidth + 1 ||
					rect.bottom > window.innerHeight + 1
				) {
					issues.push({
						selector: sel,
						rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
						viewport: { w: window.innerWidth, h: window.innerHeight },
					});
				}
			}
		}
		return issues;
	});
	expect(clipped).toEqual([]);
}

export function questionInput(page, field = "answer") {
	if (field !== "answer" && field !== "thinking") {
		throw new Error(`Invalid questionInput field: ${field}`);
	}
	return page.getByTestId(`${field}-field`).locator("[data-file-path-input]");
}

export async function assertTouchTargets(page, selectors) {
	if (!Array.isArray(selectors)) {
		throw new TypeError("assertTouchTargets expects an array of selectors");
	}
	const failures = await page.evaluate((sels) => {
		const checkClipPath = (clipPath, curRect) => {
			if (!clipPath || clipPath === "none") return { collapsed: false, box: null };
			const trimmed = clipPath.trim();
			const insetMatch = /^inset\((.+)\)$/i.exec(trimmed);
			if (insetMatch) {
				const rawArgs = insetMatch[1].split(/\s+round\s+/i)[0].trim().split(/\s+/);
				const resolveLen = (token, dim) => {
					if (!token) return 0;
					if (token.endsWith("%")) return (parseFloat(token) / 100) * dim;
					if (token.endsWith("px") || /^-?[\d.]+$/.test(token)) return parseFloat(token);
					return 0;
				};
				let t = 0;
				let r = 0;
				let b = 0;
				let l = 0;
				if (rawArgs.length === 1) {
					t = resolveLen(rawArgs[0], curRect.height);
					r = resolveLen(rawArgs[0], curRect.width);
					b = resolveLen(rawArgs[0], curRect.height);
					l = resolveLen(rawArgs[0], curRect.width);
				} else if (rawArgs.length === 2) {
					t = resolveLen(rawArgs[0], curRect.height);
					b = t;
					r = resolveLen(rawArgs[1], curRect.width);
					l = r;
				} else if (rawArgs.length === 3) {
					t = resolveLen(rawArgs[0], curRect.height);
					r = resolveLen(rawArgs[1], curRect.width);
					l = r;
					b = resolveLen(rawArgs[2], curRect.height);
				} else if (rawArgs.length >= 4) {
					t = resolveLen(rawArgs[0], curRect.height);
					r = resolveLen(rawArgs[1], curRect.width);
					b = resolveLen(rawArgs[2], curRect.height);
					l = resolveLen(rawArgs[3], curRect.width);
				}
				const box = {
					left: curRect.left + l,
					top: curRect.top + t,
					right: curRect.right - r,
					bottom: curRect.bottom - b,
				};
				return { collapsed: box.right <= box.left || box.bottom <= box.top, box };
			}
			const circleMatch = /^circle\(\s*([^\s)]+)/i.exec(trimmed);
			if (circleMatch) {
				const radius = parseFloat(circleMatch[1]);
				if (!Number.isNaN(radius) && radius <= 0) return { collapsed: true, box: null };
			}
			const ellipseMatch = /^ellipse\(\s*([^\s]+)\s+([^\s)]+)/i.exec(trimmed);
			if (ellipseMatch) {
				const rx = parseFloat(ellipseMatch[1]);
				const ry = parseFloat(ellipseMatch[2]);
				if ((!Number.isNaN(rx) && rx <= 0) || (!Number.isNaN(ry) && ry <= 0)) {
					return { collapsed: true, box: null };
				}
			}
			const polyMatch = /^polygon\((.+)\)$/i.exec(trimmed);
			if (polyMatch) {
				const pts = polyMatch[1]
					.split(",")
					.map((pair) => pair.trim().split(/\s+/))
					.filter((pair) => pair.length >= 2)
					.map(([x, y]) => [
						x.endsWith("%") ? (parseFloat(x) / 100) * curRect.width : parseFloat(x),
						y.endsWith("%") ? (parseFloat(y) / 100) * curRect.height : parseFloat(y),
					])
					.filter(([x, y]) => !Number.isNaN(x) && !Number.isNaN(y));
				if (pts.length < 3) return { collapsed: true, box: null };
				let area2 = 0;
				for (let i = 0; i < pts.length; i++) {
					const [x1, y1] = pts[i];
					const [x2, y2] = pts[(i + 1) % pts.length];
					area2 += x1 * y2 - x2 * y1;
				}
				if (Math.abs(area2) / 2 < 0.01) return { collapsed: true, box: null };
			}
			const xywhMatch = /^xywh\(\s*([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+([^\s)]+)/i.exec(trimmed);
			if (xywhMatch) {
				const w = parseFloat(xywhMatch[3]);
				const h = parseFloat(xywhMatch[4]);
				if ((!Number.isNaN(w) && w <= 0) || (!Number.isNaN(h) && h <= 0)) {
					return { collapsed: true, box: null };
				}
			}
			return { collapsed: false, box: null };
		};

		const hasCssEffect = (value) => Boolean(value && value !== "none");
		const establishesFixedContainingBlock = (style) =>
			hasCssEffect(style.transform) ||
			hasCssEffect(style.translate) ||
			hasCssEffect(style.scale) ||
			hasCssEffect(style.rotate) ||
			hasCssEffect(style.filter) ||
			hasCssEffect(style.backdropFilter) ||
			hasCssEffect(style.webkitBackdropFilter) ||
			hasCssEffect(style.perspective) ||
			style.transformStyle === "preserve-3d" ||
			/\b(paint|layout|strict|content)\b/.test(style.contain || "") ||
			/\b(inline-size|size)\b/.test(style.containerType || "") ||
			style.contentVisibility === "auto" ||
			style.contentVisibility === "hidden" ||
			/(?:^|[\s,])(transform|translate|rotate|scale|filter|-webkit-backdrop-filter|backdrop-filter|perspective|contain|transform-style|container-type|content-visibility)(?=$|[\s,])/.test(
				style.willChange || "",
			);

		const out = [];
		for (const sel of sels) {
			const matches = document.querySelectorAll(sel);
			if (matches.length === 0) {
				out.push({ selector: sel, reason: "missing" });
				continue;
			}
			for (let index = 0; index < matches.length; index++) {
				const el = matches[index];
				const elStyle = window.getComputedStyle(el);
				const rect = el.getBoundingClientRect();
				if (rect.width === 0 && rect.height === 0) {
					out.push({ selector: sel, index, reason: "hidden", width: rect.width, height: rect.height });
					continue;
				}
				if (elStyle.pointerEvents === "none") {
					out.push({ selector: sel, index, reason: "pointer_events_none", width: rect.width, height: rect.height });
					continue;
				}
				if (
					typeof el.checkVisibility === "function" &&
					el.checkVisibility({ checkVisibilityCSS: true }) === false
				) {
					out.push({ selector: sel, index, reason: "hidden", width: rect.width, height: rect.height });
					continue;
				}

				let visLeft = rect.left;
				let visTop = rect.top;
				let visRight = rect.right;
				let visBottom = rect.bottom;
				let hidden = false;
				let fixedUncontained = elStyle.position === "fixed";
				let absUncontained = elStyle.position === "absolute";

				for (let cur = el; cur && cur.nodeType === 1; cur = cur.parentElement) {
					const curStyle = window.getComputedStyle(cur);
					if (cur !== el && curStyle.display === "contents") {
						continue;
					}
					if (
						curStyle.display === "none" ||
						(cur === el && (curStyle.visibility === "hidden" || curStyle.visibility === "collapse")) ||
						parseFloat(curStyle.opacity || "1") === 0
					) {
						hidden = true;
						break;
					}
					const curRect = cur.getBoundingClientRect();
					const clipCheck = checkClipPath(curStyle.clipPath, curRect);
					if (clipCheck.collapsed) {
						hidden = true;
						break;
					}
					if (clipCheck.box) {
						visLeft = Math.max(visLeft, clipCheck.box.left);
						visTop = Math.max(visTop, clipCheck.box.top);
						visRight = Math.min(visRight, clipCheck.box.right);
						visBottom = Math.min(visBottom, clipCheck.box.bottom);
					}
					if (cur !== el && cur !== document.documentElement) {
						if (fixedUncontained && establishesFixedContainingBlock(curStyle)) {
							fixedUncontained = false;
						}
						if (absUncontained && (curStyle.position !== "static" || establishesFixedContainingBlock(curStyle))) {
							absUncontained = false;
						}
						if (!fixedUncontained && !absUncontained) {
							const isBody = cur === document.body;
							const clipX =
								curStyle.overflowX === "hidden" ||
								curStyle.overflowX === "clip" ||
								(!isBody && (curStyle.overflowX === "auto" || curStyle.overflowX === "scroll"));
							const clipY =
								curStyle.overflowY === "hidden" ||
								curStyle.overflowY === "clip" ||
								(!isBody && (curStyle.overflowY === "auto" || curStyle.overflowY === "scroll"));
							if (clipX) {
								visLeft = Math.max(visLeft, curRect.left);
								visRight = Math.min(visRight, curRect.right);
							}
							if (clipY) {
								visTop = Math.max(visTop, curRect.top);
								visBottom = Math.min(visBottom, curRect.bottom);
							}
						}
						if (curStyle.position === "fixed") {
							fixedUncontained = true;
						} else if (curStyle.position === "absolute") {
							absUncontained = true;
						}
					}
				}

				if (hidden) {
					out.push({ selector: sel, index, reason: "hidden", width: 0, height: 0 });
					continue;
				}

				visLeft = Math.max(visLeft, 0);
				visTop = Math.max(visTop, 0);
				visRight = Math.min(visRight, window.innerWidth);
				visBottom = Math.min(visBottom, window.innerHeight);

				const visibleWidth = Math.max(0, visRight - visLeft);
				const visibleHeight = Math.max(0, visBottom - visTop);
				if (visibleWidth <= 0 || visibleHeight <= 0) {
					out.push({ selector: sel, index, reason: "hidden", width: visibleWidth, height: visibleHeight });
					continue;
				}

				const cx = visLeft + visibleWidth / 2;
				const cy = visTop + visibleHeight / 2;
				const hit = document.elementFromPoint(cx, cy);
				if (hit && !el.contains(hit)) {
					out.push({
						selector: sel,
						index,
						reason: "occluded",
						width: visibleWidth,
						height: visibleHeight,
						occludedBy: hit.tagName.toLowerCase(),
					});
					continue;
				}

				if (visibleWidth < 43.95 || visibleHeight < 43.95) {
					out.push({ selector: sel, index, reason: "too_small", width: visibleWidth, height: visibleHeight });
				}
			}
		}
		return out;
	}, selectors);
	expect(failures).toEqual([]);
}
