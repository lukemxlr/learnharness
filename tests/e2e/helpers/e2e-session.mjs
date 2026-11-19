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
		vvScale: window.visualViewport ? window.visualViewport.scale : 1,
	}));
	const subpixelZoomTolerance =
		dims.scrollWidth - dims.clientWidth <= 1 &&
		Number.isFinite(dims.vvScale) &&
		dims.vvScale < 0.9995
			? 1
			: 0;
	expect(dims.scrollWidth).toBeLessThanOrEqual(dims.clientWidth + subpixelZoomTolerance);
}

const POPOVER_SELECTORS = [
	'[role="menu"]',
	'[role="listbox"]',
	'[role="dialog"]',
	"dialog[open]",
	"[popover]:popover-open",
	"[data-lh-menu]",
	'[data-testid="model-menu"]',
	'[data-testid="thinking-menu"]',
];

async function runDomGeometryCheck(page, { mode, selectors }) {
	return page.evaluate(
		({ checkMode, sels }) => {
			const tEvalStart = performance.now();
			const splitTopLevelArgs = (str) => {
				const out = [];
				let cur = "";
				let depth = 0;
				for (let i = 0; i < str.length; i++) {
					const ch = str[i];
					if (ch === "(") depth++;
					else if (ch === ")" && depth > 0) depth--;
					if (depth === 0 && /\s/.test(ch)) {
						if (cur) {
							out.push(cur);
							cur = "";
						}
					} else {
						cur += ch;
					}
				}
				if (cur) out.push(cur);
				return out;
			};

			const splitTopLevelCommas = (str) => {
				const out = [];
				let cur = "";
				let depth = 0;
				for (let i = 0; i < str.length; i++) {
					const ch = str[i];
					if (ch === "(") depth++;
					else if (ch === ")" && depth > 0) depth--;
					if (depth === 0 && ch === ",") {
						out.push(cur.trim());
						cur = "";
					} else {
						cur += ch;
					}
				}
				if (cur.trim()) out.push(cur.trim());
				return out;
			};

			const stripTopLevelRound = (str) => {
				let depth = 0;
				for (let i = 0; i < str.length; i++) {
					const ch = str[i];
					if (ch === "(") depth++;
					else if (ch === ")" && depth > 0) depth--;
					else if (depth === 0 && /^\s+round\b/i.test(str.slice(i))) {
						return str.slice(0, i).trim();
					}
				}
				return str.trim();
			};

			const evalCssLength = (expr, dim, pxScale = 1) => {
				if (typeof expr !== "string") return NaN;
				const s = expr.trim();
				if (!s) return NaN;
				const tokens = [];
				let i = 0;
				while (i < s.length) {
					if (/\s/.test(s[i])) {
						i++;
						continue;
					}
					if ("()+-*/,".includes(s[i])) {
						const prev = tokens[tokens.length - 1];
						const canBeUnary = !prev || prev.type === "op" || prev.type === "(" || prev.type === ",";
						if ((s[i] === "+" || s[i] === "-") && canBeUnary && /[\d.]/.test(s[i + 1] || "")) {
							const numMatch = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?(?:%|px)?/i.exec(s.slice(i));
							if (numMatch) {
								tokens.push({ type: "val", raw: numMatch[0] });
								i += numMatch[0].length;
								continue;
							}
						}
						if (s[i] === "(" || s[i] === ")" || s[i] === ",") {
							tokens.push({ type: s[i] });
						} else {
							tokens.push({ type: "op", op: s[i] });
						}
						i++;
						continue;
					}
					const fnMatch = /^(calc|min|max|clamp)\s*\(/i.exec(s.slice(i));
					if (fnMatch) {
						tokens.push({ type: "fn", name: fnMatch[1].toLowerCase() });
						i += fnMatch[0].length;
						continue;
					}
					const valMatch = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?(?:%|px)?/i.exec(s.slice(i));
					if (valMatch) {
						tokens.push({ type: "val", raw: valMatch[0] });
						i += valMatch[0].length;
						continue;
					}
					return NaN;
				}

				let pos = 0;
				const peek = () => tokens[pos];
				const consume = () => tokens[pos++];

				const parseVal = (raw) => {
					const lower = raw.toLowerCase();
					if (lower.endsWith("%")) {
						const n = parseFloat(lower.slice(0, -1));
						return Number.isFinite(n) ? (n / 100) * dim : NaN;
					}
					if (lower.endsWith("px")) {
						const n = parseFloat(lower.slice(0, -2));
						return Number.isFinite(n) ? n * pxScale : NaN;
					}
					const n = parseFloat(lower);
					return Number.isFinite(n) ? n : NaN;
				};

				const parseExpr = () => {
					let left = parseTerm();
					while (peek()?.type === "op" && (peek().op === "+" || peek().op === "-")) {
						const op = consume().op;
						const right = parseTerm();
						left = op === "+" ? left + right : left - right;
					}
					return left;
				};

				const parseTerm = () => {
					let left = parseFactor();
					while (peek()?.type === "op" && (peek().op === "*" || peek().op === "/")) {
						const op = consume().op;
						const right = parseFactor();
						if (op === "*") left = left * right;
						else left = right === 0 ? NaN : left / right;
					}
					return left;
				};

				const parseFactor = () => {
					const tok = peek();
					if (!tok) return NaN;
					if (tok.type === "op" && (tok.op === "+" || tok.op === "-")) {
						consume();
						const v = parseFactor();
						return tok.op === "-" ? -v : v;
					}
					if (tok.type === "(") {
						consume();
						const v = parseExpr();
						if (consume()?.type !== ")") return NaN;
						return v;
					}
					if (tok.type === "fn") {
						const name = consume().name;
						const args = [parseExpr()];
						while (peek()?.type === ",") {
							consume();
							args.push(parseExpr());
						}
						if (consume()?.type !== ")") return NaN;
						if (!args.every(Number.isFinite)) return NaN;
						if (name === "calc") return args.length === 1 ? args[0] : NaN;
						if (name === "min") return Math.min(...args);
						if (name === "max") return Math.max(...args);
						if (name === "clamp") return args.length === 3 ? Math.max(args[0], Math.min(args[1], args[2])) : NaN;
						return NaN;
					}
					if (tok.type === "val") {
						consume();
						return parseVal(tok.raw);
					}
					return NaN;
				};

				const result = parseExpr();
				if (pos !== tokens.length || !Number.isFinite(result)) return NaN;
				return result;
			};

			const resolvePos = (posTokens, W, H, scaleX = 1, scaleY = 1) => {
				if (!posTokens || posTokens.length === 0) return { cx: W / 2, cy: H / 2 };
				const kwVal = (tok, dim, pxScale) => {
					const lower = tok.toLowerCase();
					if (lower === "left" || lower === "top") return 0;
					if (lower === "center") return dim / 2;
					if (lower === "right" || lower === "bottom") return dim;
					return evalCssLength(tok, dim, pxScale);
				};
				if (posTokens.length === 1) {
					const t0 = posTokens[0].toLowerCase();
					if (t0 === "top" || t0 === "bottom") return { cx: W / 2, cy: kwVal(t0, H, scaleY) };
					return { cx: kwVal(posTokens[0], W, scaleX), cy: H / 2 };
				}
				let xTok = posTokens[0];
				let yTok = posTokens[1];
				if (/^(top|bottom)$/i.test(xTok) || /^(left|right)$/i.test(yTok)) {
					[xTok, yTok] = [yTok, xTok];
				}
				return { cx: kwVal(xTok, W, scaleX), cy: kwVal(yTok, H, scaleY) };
			};

			const checkClipPath = (clipPath, curRect, curStyle = null, scaleX = 1, scaleY = 1) => {
				if (!clipPath || clipPath === "none") return { collapsed: false, box: null, isRounded: false };
				let trimmed = clipPath.trim();
				let boxKw = null;
				const boxNames = "border-box|padding-box|content-box|fill-box|stroke-box|view-box|margin-box";
				const leadM = new RegExp(`^(${boxNames})\\s+(.+)$`, "i").exec(trimmed);
				if (leadM) {
					boxKw = leadM[1].toLowerCase();
					trimmed = leadM[2].trim();
				} else {
					const trailM = new RegExp(`^(.+?)\\s+(${boxNames})$`, "i").exec(trimmed);
					if (trailM) {
						trimmed = trailM[1].trim();
						boxKw = trailM[2].toLowerCase();
					} else if (new RegExp(`^(${boxNames})$`, "i").test(trimmed)) {
						boxKw = trimmed.toLowerCase();
						trimmed = "";
					}
				}

				let refLeft = curRect.left;
				let refTop = curRect.top;
				let refRight = curRect.right;
				let refBottom = curRect.bottom;
				if (curStyle && (boxKw === "padding-box" || boxKw === "content-box")) {
					const bl = (parseFloat(curStyle.borderLeftWidth) || 0) * scaleX;
					const br = (parseFloat(curStyle.borderRightWidth) || 0) * scaleX;
					const bt = (parseFloat(curStyle.borderTopWidth) || 0) * scaleY;
					const bb = (parseFloat(curStyle.borderBottomWidth) || 0) * scaleY;
					const pl = boxKw === "content-box" ? (parseFloat(curStyle.paddingLeft) || 0) * scaleX : 0;
					const pr = boxKw === "content-box" ? (parseFloat(curStyle.paddingRight) || 0) * scaleX : 0;
					const pt = boxKw === "content-box" ? (parseFloat(curStyle.paddingTop) || 0) * scaleY : 0;
					const pb = boxKw === "content-box" ? (parseFloat(curStyle.paddingBottom) || 0) * scaleY : 0;
					refLeft += bl + pl;
					refRight -= br + pr;
					refTop += bt + pt;
					refBottom -= bb + pb;
				}
				const W = Math.max(0, refRight - refLeft);
				const H = Math.max(0, refBottom - refTop);

				if (!trimmed) {
					const box = { left: refLeft, top: refTop, right: refRight, bottom: refBottom };
					return { collapsed: box.right <= box.left || box.bottom <= box.top, box, isRounded: false };
				}

				const insetMatch = /^inset\((.+)\)$/i.exec(trimmed);
				if (insetMatch) {
					const beforeRound = stripTopLevelRound(insetMatch[1]);
					const isRounded = beforeRound !== insetMatch[1].trim();
					const rawArgs = splitTopLevelArgs(beforeRound);
					let t = 0;
					let r = 0;
					let b = 0;
					let l = 0;
					if (rawArgs.length === 1) {
						t = evalCssLength(rawArgs[0], H, scaleY);
						r = evalCssLength(rawArgs[0], W, scaleX);
						b = t;
						l = r;
					} else if (rawArgs.length === 2) {
						t = evalCssLength(rawArgs[0], H, scaleY);
						b = t;
						r = evalCssLength(rawArgs[1], W, scaleX);
						l = r;
					} else if (rawArgs.length === 3) {
						t = evalCssLength(rawArgs[0], H, scaleY);
						r = evalCssLength(rawArgs[1], W, scaleX);
						l = r;
						b = evalCssLength(rawArgs[2], H, scaleY);
					} else if (rawArgs.length >= 4) {
						t = evalCssLength(rawArgs[0], H, scaleY);
						r = evalCssLength(rawArgs[1], W, scaleX);
						b = evalCssLength(rawArgs[2], H, scaleY);
						l = evalCssLength(rawArgs[3], W, scaleX);
					}
					if (![t, r, b, l].every(Number.isFinite)) {
						return { collapsed: false, box: null, isRounded };
					}
					const box = {
						left: refLeft + l,
						top: refTop + t,
						right: refRight - r,
						bottom: refBottom - b,
					};
					return { collapsed: box.right <= box.left || box.bottom <= box.top, box, isRounded };
				}

				const xywhMatch = /^xywh\((.+)\)$/i.exec(trimmed);
				if (xywhMatch) {
					const beforeRound = stripTopLevelRound(xywhMatch[1]);
					const isRounded = beforeRound !== xywhMatch[1].trim();
					const rawArgs = splitTopLevelArgs(beforeRound);
					if (rawArgs.length < 4) return { collapsed: false, box: null, isRounded };
					const x = evalCssLength(rawArgs[0], W, scaleX);
					const y = evalCssLength(rawArgs[1], H, scaleY);
					const w = evalCssLength(rawArgs[2], W, scaleX);
					const h = evalCssLength(rawArgs[3], H, scaleY);
					if (![x, y, w, h].every(Number.isFinite)) return { collapsed: false, box: null, isRounded };
					if (w <= 0 || h <= 0) return { collapsed: true, box: null, isRounded };
					return {
						collapsed: false,
						box: {
							left: refLeft + x,
							top: refTop + y,
							right: refLeft + x + w,
							bottom: refTop + y + h,
						},
						isRounded,
					};
				}

				const circleMatch = /^circle\((.*)\)$/i.exec(trimmed);
				if (circleMatch) {
					const tokens = splitTopLevelArgs(circleMatch[1].trim());
					const atIdx = tokens.findIndex((t) => t.toLowerCase() === "at");
					const rTok = atIdx === 0 ? "closest-side" : tokens[0] || "closest-side";
					const posTokens = atIdx >= 0 ? tokens.slice(atIdx + 1) : [];
					const { cx, cy } = resolvePos(posTokens, W, H, scaleX, scaleY);
					if (!Number.isFinite(cx) || !Number.isFinite(cy)) return { collapsed: false, box: null, isRounded: true };
					const sx = scaleX > 0 ? scaleX : 1;
					const sy = scaleY > 0 ? scaleY : 1;
					const localW = W / sx;
					const localH = H / sy;
					const localCx = cx / sx;
					const localCy = cy / sy;
					let rLocal;
					if (/^closest-side$/i.test(rTok)) {
						rLocal = Math.min(
							Math.abs(localCx),
							Math.abs(localW - localCx),
							Math.abs(localCy),
							Math.abs(localH - localCy),
						);
					} else if (/^farthest-side$/i.test(rTok)) {
						rLocal = Math.max(
							Math.abs(localCx),
							Math.abs(localW - localCx),
							Math.abs(localCy),
							Math.abs(localH - localCy),
						);
					} else {
						rLocal = evalCssLength(rTok, Math.hypot(localW, localH) / Math.SQRT2, 1);
					}
					if (!Number.isFinite(rLocal)) return { collapsed: false, box: null, isRounded: true };
					if (rLocal <= 0) return { collapsed: true, box: null, isRounded: true };
					const rx = rLocal * sx;
					const ry = rLocal * sy;
					return {
						collapsed: false,
						box: {
							left: refLeft + cx - rx,
							top: refTop + cy - ry,
							right: refLeft + cx + rx,
							bottom: refTop + cy + ry,
						},
						isRounded: true,
					};
				}

				const ellipseMatch = /^ellipse\((.*)\)$/i.exec(trimmed);
				if (ellipseMatch) {
					const tokens = splitTopLevelArgs(ellipseMatch[1].trim());
					const atIdx = tokens.findIndex((t) => t.toLowerCase() === "at");
					const rTokens = atIdx >= 0 ? tokens.slice(0, atIdx) : tokens;
					const posTokens = atIdx >= 0 ? tokens.slice(atIdx + 1) : [];
					const { cx, cy } = resolvePos(posTokens, W, H, scaleX, scaleY);
					if (!Number.isFinite(cx) || !Number.isFinite(cy)) return { collapsed: false, box: null, isRounded: true };
					const rxTok = rTokens[0] || "closest-side";
					const ryTok = rTokens[1] || "closest-side";
					const rx = /^closest-side$/i.test(rxTok)
						? Math.min(Math.abs(cx), Math.abs(W - cx))
						: /^farthest-side$/i.test(rxTok)
							? Math.max(Math.abs(cx), Math.abs(W - cx))
							: evalCssLength(rxTok, W, scaleX);
					const ry = /^closest-side$/i.test(ryTok)
						? Math.min(Math.abs(cy), Math.abs(H - cy))
						: /^farthest-side$/i.test(ryTok)
							? Math.max(Math.abs(cy), Math.abs(H - cy))
							: evalCssLength(ryTok, H, scaleY);
					if (!Number.isFinite(rx) || !Number.isFinite(ry)) return { collapsed: false, box: null, isRounded: true };
					if (rx <= 0 || ry <= 0) return { collapsed: true, box: null, isRounded: true };
					return {
						collapsed: false,
						box: {
							left: refLeft + cx - rx,
							top: refTop + cy - ry,
							right: refLeft + cx + rx,
							bottom: refTop + cy + ry,
						},
						isRounded: true,
					};
				}

				const polyMatch = /^polygon\((.+)\)$/i.exec(trimmed);
				if (polyMatch) {
					const parts = splitTopLevelCommas(polyMatch[1]);
					if (parts.length > 0 && /^(nonzero|evenodd)$/i.test(parts[0])) {
						parts.shift();
					}
					const pts = [];
					for (const part of parts) {
						const pair = splitTopLevelArgs(part);
						if (pair.length < 2) continue;
						const x = evalCssLength(pair[0], W, scaleX);
						const y = evalCssLength(pair[1], H, scaleY);
						if (!Number.isFinite(x) || !Number.isFinite(y)) {
							return { collapsed: false, box: null, isRounded: false };
						}
						pts.push([x, y]);
					}
					if (pts.length < 3) return { collapsed: true, box: null, isRounded: false };
					let area2 = 0;
					let minX = Infinity;
					let minY = Infinity;
					let maxX = -Infinity;
					let maxY = -Infinity;
					for (let i = 0; i < pts.length; i++) {
						const [x1, y1] = pts[i];
						const [x2, y2] = pts[(i + 1) % pts.length];
						area2 += x1 * y2 - x2 * y1;
						if (x1 < minX) minX = x1;
						if (x1 > maxX) maxX = x1;
						if (y1 < minY) minY = y1;
						if (y1 > maxY) maxY = y1;
					}
					if (Math.abs(area2) / 2 < 0.01) return { collapsed: true, box: null, isRounded: false };
					return {
						collapsed: false,
						box: {
							left: refLeft + minX,
							top: refTop + minY,
							right: refLeft + maxX,
							bottom: refTop + maxY,
						},
						isRounded: false,
					};
				}
				return { collapsed: false, box: null, isRounded: false };
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
				/(?:^|[\s,])(transform|translate|rotate|scale|filter|-webkit-backdrop-filter|backdrop-filter|perspective|contain|transform-style)(?=$|[\s,])/.test(
					style.willChange || "",
				);

			const hasNonZeroBorderRadius = (style) =>
				[
					style.borderTopLeftRadius,
					style.borderTopRightRadius,
					style.borderBottomRightRadius,
					style.borderBottomLeftRadius,
				].some((r) => parseFloat(r || "0") > 0);

			const FLEX_OR_GRID_DISPLAY = new Set(["flex", "inline-flex", "grid", "inline-grid"]);
			const createsStackingContext = (style, node = null) => {
				if (
					style.position === "fixed" ||
					style.position === "sticky" ||
					(style.position !== "static" && Number.isFinite(parseInt(style.zIndex, 10))) ||
					parseFloat(style.opacity || "1") < 1 ||
					establishesFixedContainingBlock(style) ||
					style.isolation === "isolate" ||
					(style.mixBlendMode && style.mixBlendMode !== "normal") ||
					(style.clipPath && style.clipPath !== "none") ||
					(style.maskImage && style.maskImage !== "none") ||
					(style.webkitMaskImage && style.webkitMaskImage !== "none") ||
					/(?:^|[\s,])(opacity|isolation|mix-blend-mode|clip-path|mask|-webkit-mask|z-index|position)(?=$|[\s,])/.test(
						style.willChange || "",
					)
				) {
					return true;
				}
				if (node && node.parentElement && Number.isFinite(parseInt(style.zIndex, 10))) {
					let p = node.parentElement;
					while (p && p.nodeType === 1 && window.getComputedStyle(p).display === "contents") {
						p = p.parentElement;
					}
					if (p && p.nodeType === 1 && FLEX_OR_GRID_DISPLAY.has(window.getComputedStyle(p).display)) {
						return true;
					}
				}
				return false;
			};

			const computeAncestorClip = (el, elStyle, rect) => {
				let visLeft = rect.left;
				let visTop = rect.top;
				let visRight = rect.right;
				let visBottom = rect.bottom;
				let hidden = false;
				let clipCollapsed = false;
				let hasRoundedClip = hasNonZeroBorderRadius(elStyle);
				let hasAnyClipPath = false;
				let hasAnyMask = false;
				let hasSkewOrRotation = false;
				let hasNegZAncestor = parseInt(elStyle.zIndex, 10) < 0;
				let hasStackingContextAncestor = false;
				let fixedUncontained = elStyle.position === "fixed";
				let absUncontained = elStyle.position === "absolute";

				for (let cur = el; cur && cur.nodeType === 1; cur = cur.parentElement) {
					const curStyle = window.getComputedStyle(cur);
					if (cur !== el && cur !== document.documentElement && createsStackingContext(curStyle, cur)) {
						hasStackingContextAncestor = true;
					}
					if (curStyle.clipPath && curStyle.clipPath !== "none") hasAnyClipPath = true;
					if (
						(curStyle.maskImage && curStyle.maskImage !== "none") ||
						(curStyle.webkitMaskImage && curStyle.webkitMaskImage !== "none")
					) {
						hasAnyMask = true;
					}
					if (curStyle.rotate && curStyle.rotate !== "none" && curStyle.rotate !== "0deg") {
						hasSkewOrRotation = true;
					}
					if (curStyle.transform && curStyle.transform !== "none") {
						const m = curStyle.transform.match(/^matrix\(([^)]+)\)$/);
						if (!m) {
							hasSkewOrRotation = true;
						} else {
							const parts = m[1].split(",").map(Number);
							if (Math.abs(parts[1]) > 1e-4 || Math.abs(parts[2]) > 1e-4) {
								hasSkewOrRotation = true;
							}
						}
					}
					if (parseInt(curStyle.zIndex, 10) < 0) hasNegZAncestor = true;
					if (cur !== el && curStyle.display === "contents") continue;
					if (
						curStyle.display === "none" ||
						(cur === el && (curStyle.visibility === "hidden" || curStyle.visibility === "collapse")) ||
						parseFloat(curStyle.opacity || "1") === 0
					) {
						hidden = true;
						break;
					}
					const curRect = cur.getBoundingClientRect();
					const scaleX = typeof cur.offsetWidth === "number" && cur.offsetWidth > 0 ? curRect.width / cur.offsetWidth : 1;
					const scaleY = typeof cur.offsetHeight === "number" && cur.offsetHeight > 0 ? curRect.height / cur.offsetHeight : 1;
					const clipCheck = checkClipPath(curStyle.clipPath, curRect, curStyle, scaleX, scaleY);
					if (clipCheck.isRounded) hasRoundedClip = true;
					if (clipCheck.collapsed) {
						clipCollapsed = true;
						if (checkMode === "touch") {
							hidden = true;
							break;
						}
					} else if (
						clipCheck.box &&
						Number.isFinite(clipCheck.box.left) &&
						Number.isFinite(clipCheck.box.top) &&
						Number.isFinite(clipCheck.box.right) &&
						Number.isFinite(clipCheck.box.bottom)
					) {
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
							const bl = (parseFloat(curStyle.borderLeftWidth) || 0) * scaleX;
							const br = (parseFloat(curStyle.borderRightWidth) || 0) * scaleX;
							const bt = (parseFloat(curStyle.borderTopWidth) || 0) * scaleY;
							const bb = (parseFloat(curStyle.borderBottomWidth) || 0) * scaleY;
							const isBody = cur === document.body;
							const clipX =
								curStyle.overflowX === "hidden" ||
								curStyle.overflowX === "clip" ||
								(!isBody && (curStyle.overflowX === "auto" || curStyle.overflowX === "scroll"));
							const clipY =
								curStyle.overflowY === "hidden" ||
								curStyle.overflowY === "clip" ||
								(!isBody && (curStyle.overflowY === "auto" || curStyle.overflowY === "scroll"));
							if (clipX && clipY && hasNonZeroBorderRadius(curStyle)) {
								hasRoundedClip = true;
							}
							if (clipX) {
								visLeft = Math.max(visLeft, curRect.left + bl);
								visRight = Math.min(visRight, curRect.right - br);
							}
							if (clipY) {
								visTop = Math.max(visTop, curRect.top + bt);
								visBottom = Math.min(visBottom, curRect.bottom - bb);
							}
						}
						if (curStyle.position === "fixed") {
							fixedUncontained = true;
						} else if (curStyle.position === "absolute") {
							absUncontained = true;
						}
					}
				}
				return {
					visLeft,
					visTop,
					visRight,
					visBottom,
					hidden,
					clipCollapsed,
					hasRoundedClip,
					hasAnyClipPath,
					hasAnyMask,
					hasSkewOrRotation,
					hasNegZAncestor,
					hasStackingContextAncestor,
				};
			};

			if (checkMode === "popovers") {
				const seen = new Set();
				const issues = [];
				for (const sel of sels) {
					let matches;
					try {
						matches = document.querySelectorAll(sel);
					} catch {
						continue;
					}
					for (const el of matches) {
						if (seen.has(el)) continue;
						seen.add(el);

						const rect = el.getBoundingClientRect();
						if (rect.width === 0 && rect.height === 0) continue;
						if (
							typeof el.checkVisibility === "function" &&
							el.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true }) === false
						) {
							continue;
						}
						const elStyle = window.getComputedStyle(el);
						if (
							elStyle.display === "none" ||
							elStyle.visibility === "hidden" ||
							elStyle.visibility === "collapse" ||
							parseFloat(elStyle.opacity || "1") === 0
						) {
							continue;
						}

						const clip = computeAncestorClip(el, elStyle, rect);
						if (clip.hidden) continue;

						const overflowClipped =
							clip.clipCollapsed ||
							clip.visLeft > rect.left + 1 ||
							clip.visTop > rect.top + 1 ||
							clip.visRight < rect.right - 1 ||
							clip.visBottom < rect.bottom - 1;
						const viewportClipped =
							rect.left < -1 ||
							rect.top < -1 ||
							rect.right > window.innerWidth + 1 ||
							rect.bottom > window.innerHeight + 1;

						if (viewportClipped || overflowClipped) {
							issues.push({
								selector: sel,
								reason: overflowClipped ? "overflow_clipped" : "viewport_clipped",
								rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
								visibleRect: { left: clip.visLeft, top: clip.visTop, right: clip.visRight, bottom: clip.visBottom },
								viewport: { w: window.innerWidth, h: window.innerHeight },
							});
						}
					}
				}
				return issues;
			}

			// checkMode === "touch"
			const out = [];
			let cachedOverlays = null;
			const hasTransformProp = (st) =>
				hasCssEffect(st.transform) ||
				hasCssEffect(st.scale) ||
				(st.rotate && st.rotate !== "none" && st.rotate !== "0deg") ||
				hasCssEffect(st.translate) ||
				hasCssEffect(st.perspective);
			const SHADOW_HOST_TAGS = new Set([
				"ARTICLE",
				"ASIDE",
				"BLOCKQUOTE",
				"BODY",
				"DIV",
				"FOOTER",
				"H1",
				"H2",
				"H3",
				"H4",
				"H5",
				"H6",
				"HEADER",
				"MAIN",
				"NAV",
				"P",
				"SECTION",
				"SPAN",
			]);
			const isShadowCapable = (node) =>
				Boolean(node && node.tagName && (node.tagName.includes("-") || SHADOW_HOST_TAGS.has(node.tagName)));
			const getDomOverlays = () => {
				if (cachedOverlays !== null) return cachedOverlays;
				const nodes = document.querySelectorAll("*");
				const domRects = [];
				const pseudoRects = [];
				const closedShadowZeroNodes = [];
				const closedShadowNoneNodes = [];
				const domIdxMap = new Map();
				let hasShadowDom = false;
				let hasUnboundedPseudo = false;
				const parseTranslate = (tr) => {
					if (!tr || tr === "none") return { ok: true, tx: 0, ty: 0 };
					const m = tr.match(/^matrix\(([^)]+)\)$/);
					if (!m) return { ok: false, tx: 0, ty: 0 };
					const p = m[1].split(",").map(Number);
					if (
						Math.abs(p[0] - 1) > 1e-4 ||
						Math.abs(p[1]) > 1e-4 ||
						Math.abs(p[2]) > 1e-4 ||
						Math.abs(p[3] - 1) > 1e-4
					) {
						return { ok: false, tx: 0, ty: 0 };
					}
					return { ok: true, tx: p[4] || 0, ty: p[5] || 0 };
				};
				for (let i = 0; i < nodes.length; i++) {
					const node = nodes[i];
					domIdxMap.set(node, i);
					if (node.shadowRoot || (node.tagName && node.tagName.includes("-") && !node.shadowRoot)) {
						hasShadowDom = true;
					}
					const r = node.getBoundingClientRect();
					const ns = window.getComputedStyle(node);
					if (r.width > 0 && r.height > 0) {
						domRects.push({ node, rect: r, domIdx: i, style: ns });
					}
					if (
						isShadowCapable(node) &&
						!node.shadowRoot &&
						node.childElementCount === 0 &&
						(!node.textContent || !node.textContent.trim())
					) {
						if (r.width === 0 || r.height === 0) {
							closedShadowZeroNodes.push(node);
						} else if (ns.pointerEvents === "none") {
							closedShadowNoneNodes.push({ node, rect: r });
						}
					}
					for (const pseudo of ["::before", "::after"]) {
						const ps = window.getComputedStyle(node, pseudo);
						if (
							!ps.content ||
							ps.content === "none" ||
							ps.content === "normal" ||
							ps.display === "none" ||
							ps.visibility === "hidden" ||
							ps.visibility === "collapse" ||
							ps.pointerEvents === "none"
						) {
							continue;
						}
						if (ns.display === "none") {
							continue;
						}
						if (ps.position === "absolute" || ps.position === "fixed") {
							const tr = parseTranslate(ps.transform);
							if (
								!tr.ok ||
								(ps.rotate && ps.rotate !== "none" && ps.rotate !== "0deg") ||
								hasCssEffect(ps.scale) ||
								hasCssEffect(ps.translate)
							) {
								hasUnboundedPseudo = true;
								continue;
							}
							let pw = parseFloat(ps.width);
							let ph = parseFloat(ps.height);
							if (!Number.isFinite(pw) || !Number.isFinite(ph)) {
								hasUnboundedPseudo = true;
								continue;
							}
							if (ps.boxSizing !== "border-box") {
								pw +=
									(parseFloat(ps.paddingLeft) || 0) +
									(parseFloat(ps.paddingRight) || 0) +
									(parseFloat(ps.borderLeftWidth) || 0) +
									(parseFloat(ps.borderRightWidth) || 0);
								ph +=
									(parseFloat(ps.paddingTop) || 0) +
									(parseFloat(ps.paddingBottom) || 0) +
									(parseFloat(ps.borderTopWidth) || 0) +
									(parseFloat(ps.borderBottomWidth) || 0);
							}
							let cbL = 0;
							let cbT = 0;
							let cbR = window.innerWidth;
							let cbB = window.innerHeight;
							let cbOk = true;
							if (ps.position === "fixed") {
								let fixedCb = null;
								for (let anc = node; anc && anc.nodeType === 1; anc = anc.parentElement) {
									const as = anc === node ? ns : window.getComputedStyle(anc);
									if (!fixedCb && establishesFixedContainingBlock(as)) {
										fixedCb = { anc, as };
									}
									if (hasTransformProp(as)) {
										cbOk = false;
										break;
									}
								}
								if (cbOk && fixedCb) {
									const ar = fixedCb.anc === node ? r : fixedCb.anc.getBoundingClientRect();
									cbL = ar.left + (parseFloat(fixedCb.as.borderLeftWidth) || 0);
									cbT = ar.top + (parseFloat(fixedCb.as.borderTopWidth) || 0);
									cbR = ar.right - (parseFloat(fixedCb.as.borderRightWidth) || 0);
									cbB = ar.bottom - (parseFloat(fixedCb.as.borderBottomWidth) || 0);
								}
							} else {
								let cb = null;
								for (
									let anc = node;
									anc && anc.nodeType === 1 && anc !== document.documentElement;
									anc = anc.parentElement
								) {
									const as = anc === node ? ns : window.getComputedStyle(anc);
									if (as.position !== "static" || establishesFixedContainingBlock(as)) {
										cb = { anc, as };
										break;
									}
								}
								if (cb) {
									for (let anc = cb.anc; anc && anc.nodeType === 1; anc = anc.parentElement) {
										const as = anc === cb.anc ? cb.as : anc === node ? ns : window.getComputedStyle(anc);
										if (hasTransformProp(as)) {
											cbOk = false;
											break;
										}
									}
									if (cbOk) {
										const cr = cb.anc === node ? r : cb.anc.getBoundingClientRect();
										const sl = cb.anc.scrollLeft || 0;
										const st = cb.anc.scrollTop || 0;
										cbL = cr.left + (parseFloat(cb.as.borderLeftWidth) || 0) - sl;
										cbT = cr.top + (parseFloat(cb.as.borderTopWidth) || 0) - st;
										cbR = cr.right - (parseFloat(cb.as.borderRightWidth) || 0) - sl;
										cbB = cr.bottom - (parseFloat(cb.as.borderBottomWidth) || 0) - st;
									}
								} else {
									const docEl = document.documentElement;
									const bodyEl = document.body;
									if (
										(docEl && hasTransformProp(window.getComputedStyle(docEl))) ||
										(bodyEl && hasTransformProp(window.getComputedStyle(bodyEl)))
									) {
										cbOk = false;
									} else {
										cbL = -window.scrollX;
										cbT = -window.scrollY;
										cbR = cbL + (docEl ? docEl.clientWidth : window.innerWidth);
										cbB = cbT + (docEl ? docEl.clientHeight : window.innerHeight);
									}
								}
							}
							if (!cbOk) {
								hasUnboundedPseudo = true;
								continue;
							}
							const pl = parseFloat(ps.left);
							const pr = parseFloat(ps.right);
							const pt = parseFloat(ps.top);
							const pb = parseFloat(ps.bottom);
							const ml = parseFloat(ps.marginLeft) || 0;
							const mr = parseFloat(ps.marginRight) || 0;
							const mt = parseFloat(ps.marginTop) || 0;
							const mb = parseFloat(ps.marginBottom) || 0;
							const x0 =
								ps.left !== "auto" && Number.isFinite(pl)
									? cbL + pl + ml
									: ps.right !== "auto" && Number.isFinite(pr)
										? cbR - pr - mr - pw
										: NaN;
							const y0 =
								ps.top !== "auto" && Number.isFinite(pt)
									? cbT + pt + mt
									: ps.bottom !== "auto" && Number.isFinite(pb)
										? cbB - pb - mb - ph
										: NaN;
							if (!Number.isFinite(x0) || !Number.isFinite(y0)) {
								hasUnboundedPseudo = true;
								continue;
							}
							if (pw > 0 && ph > 0) {
								const fx = x0 + tr.tx;
								const fy = y0 + tr.ty;
								pseudoRects.push({
									node,
									isPseudo: true,
									isStatic: false,
									rect: { left: fx, top: fy, right: fx + pw, bottom: fy + ph, width: pw, height: ph },
									zIndex: parseInt(ps.zIndex, 10),
									domIdx: i,
								});
							}
						} else {
							const hostClipsOverflow =
								(ns.overflowX === "hidden" || ns.overflowX === "clip") &&
								(ns.overflowY === "hidden" || ns.overflowY === "clip");
							if (r.width > 0 && r.height > 0 && hostClipsOverflow && ps.position !== "sticky") {
								pseudoRects.push({
									node,
									isPseudo: true,
									isStatic: ps.position === "static",
									rect: r,
									zIndex: parseInt(ps.zIndex, 10),
									domIdx: i,
								});
							} else {
								let pw = parseFloat(ps.width);
								let ph = parseFloat(ps.height);
								if (Number.isFinite(pw) && Number.isFinite(ph) && ps.boxSizing !== "border-box") {
									pw +=
										(parseFloat(ps.paddingLeft) || 0) +
										(parseFloat(ps.paddingRight) || 0) +
										(parseFloat(ps.borderLeftWidth) || 0) +
										(parseFloat(ps.borderRightWidth) || 0);
									ph +=
										(parseFloat(ps.paddingTop) || 0) +
										(parseFloat(ps.paddingBottom) || 0) +
										(parseFloat(ps.borderTopWidth) || 0) +
										(parseFloat(ps.borderBottomWidth) || 0);
								}
								const emptyContent = ps.content === '""' || ps.content === "''";
								if (
									r.width > 0 &&
									r.height > 0 &&
									ps.position === "static" &&
									emptyContent &&
									ps.transform === "none" &&
									!hasCssEffect(ps.scale) &&
									(!ps.rotate || ps.rotate === "none" || ps.rotate === "0deg") &&
									!hasCssEffect(ps.translate) &&
									(ps.left === "auto" || ps.left === "0px") &&
									(ps.top === "auto" || ps.top === "0px") &&
									(ps.right === "auto" || ps.right === "0px") &&
									(ps.bottom === "auto" || ps.bottom === "0px") &&
									ps.marginTop === "0px" &&
									ps.marginRight === "0px" &&
									ps.marginBottom === "0px" &&
									ps.marginLeft === "0px" &&
									Number.isFinite(pw) &&
									Number.isFinite(ph) &&
									pw <= r.width + 0.01 &&
									ph <= r.height + 0.01
								) {
									pseudoRects.push({
										node,
										isPseudo: true,
										isStatic: true,
										rect: r,
										zIndex: parseInt(ps.zIndex, 10),
										domIdx: i,
									});
								} else {
									hasUnboundedPseudo = true;
								}
							}
						}
					}
				}
				cachedOverlays = {
					domRects,
					pseudoRects,
					closedShadowZeroNodes,
					closedShadowNoneNodes,
					domIdxMap,
					hasShadowDom,
					hasUnboundedPseudo,
				};
				return cachedOverlays;
			};
			const selMatches = sels.map((sel) => ({ sel, matches: document.querySelectorAll(sel) }));
			let totalTargets = 0;
			for (let si = 0; si < selMatches.length; si++) {
				totalTargets += selMatches[si].matches.length;
			}
			for (const { sel, matches } of selMatches) {
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

					const clip = computeAncestorClip(el, elStyle, rect);
					if (clip.hidden || ![clip.visLeft, clip.visTop, clip.visRight, clip.visBottom].every(Number.isFinite)) {
						out.push({ selector: sel, index, reason: "hidden", width: 0, height: 0 });
						continue;
					}

					const visLeft = Math.max(clip.visLeft, 0);
					const visTop = Math.max(clip.visTop, 0);
					const visRight = Math.min(clip.visRight, window.innerWidth);
					const visBottom = Math.min(clip.visBottom, window.innerHeight);

					const visibleWidth = Math.max(0, visRight - visLeft);
					const visibleHeight = Math.max(0, visBottom - visTop);
					if (visibleWidth <= 0 || visibleHeight <= 0) {
						out.push({ selector: sel, index, reason: "hidden", width: visibleWidth, height: visibleHeight });
						continue;
					}
					if (visibleWidth < 43.95 || visibleHeight < 43.95) {
						out.push({ selector: sel, index, reason: "too_small", width: visibleWidth, height: visibleHeight });
						continue;
					}

					const cols = Math.min(25, Math.max(13, Math.ceil(visibleWidth / 4)));
					const rows = Math.min(25, Math.max(13, Math.ceil(visibleHeight / 4)));
					const xs = [];
					for (let i = 0; i < cols; i++) {
						xs.push(visLeft + ((i + 0.5) / cols) * visibleWidth);
					}
					const ys = [];
					for (let j = 0; j < rows; j++) {
						ys.push(visTop + ((j + 0.5) / rows) * visibleHeight);
					}

					let blockerTag = null;
					const cacheX0 = Math.max(0, Math.trunc(visLeft) - 2);
					const cacheY0 = Math.max(0, Math.trunc(visTop) - 2);
					const cacheX1 = Math.trunc(visRight) + 2;
					const cacheY1 = Math.trunc(visBottom) + 2;
					const cacheW = cacheX1 - cacheX0 + 1;
					const cacheH = cacheY1 - cacheY0 + 1;
					const useFlatCache = cacheW > 0 && cacheH > 0 && cacheW * cacheH <= 4_000_000;
					const flatHitCache = useFlatCache ? new Uint8Array(cacheW * cacheH) : null;
					const subpixelHitCache = new Map();
					const blockedPts = [];
					let domBlockedCollected = false;

					let realEfpCalls = 0;
					const hitsAt = (x, y) => {
						if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) return false;
						const ix = Math.trunc(x);
						const iy = Math.trunc(y);
						const isPixelCenter = x - ix === 0.5 && y - iy === 0.5;
						if (isPixelCenter && flatHitCache && ix >= cacheX0 && ix <= cacheX1 && iy >= cacheY0 && iy <= cacheY1) {
							const idx = (iy - cacheY0) * cacheW + (ix - cacheX0);
							const cached = flatHitCache[idx];
							if (cached !== 0) return cached === 2;
							realEfpCalls++;
							const hit = document.elementFromPoint(x, y);
							const ok = Boolean(hit && (hit === el || el.contains(hit)));
							flatHitCache[idx] = ok ? 2 : 1;
							if (!ok) {
								if (hit && !blockerTag) blockerTag = hit.tagName.toLowerCase();
								if (blockedPts.length < 3000) blockedPts.push({ x, y });
							}
							return ok;
						}
						if (subpixelHitCache) {
							const key = `${Math.trunc(x * 65536)},${Math.trunc(y * 65536)}`;
							const cached = subpixelHitCache.get(key);
							if (cached !== undefined) return cached;
							realEfpCalls++;
							const hit = document.elementFromPoint(x, y);
							const ok = Boolean(hit && (hit === el || el.contains(hit)));
							subpixelHitCache.set(key, ok);
							if (!ok) {
								if (hit && !blockerTag) blockerTag = hit.tagName.toLowerCase();
								if (blockedPts.length < 3000) blockedPts.push({ x, y });
							}
							return ok;
						}
						realEfpCalls++;
						const hit = document.elementFromPoint(x, y);
						if (!hit) return false;
						if (hit === el || el.contains(hit)) return true;
						if (!blockerTag) blockerTag = hit.tagName.toLowerCase();
						if (blockedPts.length < 3000) blockedPts.push({ x, y });
						return false;
					};

					let cachedElOverlaps = null;
					const getElOverlaps = () => {
						if (cachedElOverlaps !== null) return cachedElOverlaps;
						const ov = getDomOverlays();
						const elDomIdx = ov.domIdxMap.get(el) ?? -1;
						const elZ = parseInt(elStyle.zIndex, 10);
						const elEffZ = Number.isFinite(elZ) ? elZ : elStyle.position === "static" ? -0.5 : 0;
						const items = [];
						for (let i = 0; i < ov.domRects.length; i++) {
							const entry = ov.domRects[i];
							const { node, rect: r, domIdx, style: ns } = entry;
							if (node === el || el.contains(node) || node.contains(el)) continue;
							const oL = Math.max(visLeft, r.left);
							const oR = Math.min(visRight, r.right);
							const oT = Math.max(visTop, r.top);
							const oB = Math.min(visBottom, r.bottom);
							if (oR - oL <= 0.0001 || oB - oT <= 0.0001) continue;
							if (
								ns.display === "none" ||
								ns.visibility === "hidden" ||
								ns.visibility === "collapse" ||
								ns.pointerEvents === "none"
							) {
								continue;
							}
							const nz = parseInt(ns.zIndex, 10);
							const nodeEffZ = Number.isFinite(nz) ? nz : ns.position === "static" ? -0.5 : 0;
							const tier =
								nodeEffZ > elEffZ
									? 0
									: nodeEffZ === elEffZ
										? domIdx > elDomIdx
											? 1
											: 2
										: 3;
							items.push({ node, rect: r, oL, oR, oT, oB, oW: oR - oL, oH: oB - oT, tier, effZ: nodeEffZ, domIdx });
						}
						for (let i = 0; i < ov.pseudoRects.length; i++) {
							const entry = ov.pseudoRects[i];
							const r = entry.rect;
							const oL = Math.max(visLeft, r.left);
							const oR = Math.min(visRight, r.right);
							const oT = Math.max(visTop, r.top);
							const oB = Math.min(visBottom, r.bottom);
							if (oR - oL <= 0.0001 || oB - oT <= 0.0001) continue;
							const pEffZ = Number.isFinite(entry.zIndex) ? entry.zIndex : entry.isStatic ? -0.5 : 0;
							const tier =
								pEffZ > elEffZ
									? 0
									: pEffZ === elEffZ
										? entry.domIdx >= elDomIdx
											? 1
											: 2
										: 3;
							items.push({
								node: entry.node,
								rect: r,
								oL,
								oR,
								oT,
								oB,
								oW: oR - oL,
								oH: oB - oT,
								tier,
								effZ: pEffZ,
								domIdx: entry.domIdx,
								isPseudo: true,
							});
						}
						items.sort((a, b) => a.tier - b.tier || b.effZ - a.effZ || a.domIdx - b.domIdx);
						let elHasShadowDom = ov.hasShadowDom;
						if (!elHasShadowDom) {
							for (let i = 0; i < ov.closedShadowZeroNodes.length; i++) {
								const sn = ov.closedShadowZeroNodes[i];
								if (sn !== el && !el.contains(sn) && !sn.contains(el)) {
									elHasShadowDom = true;
									break;
								}
							}
						}
						if (!elHasShadowDom) {
							for (let i = 0; i < ov.closedShadowNoneNodes.length; i++) {
								const { node: sn, rect: sr } = ov.closedShadowNoneNodes[i];
								if (
									sn !== el &&
									!el.contains(sn) &&
									!sn.contains(el) &&
									sr.right > visLeft &&
									sr.left < visRight &&
									sr.bottom > visTop &&
									sr.top < visBottom
								) {
									elHasShadowDom = true;
									break;
								}
							}
						}
						let tier01Count = 0;
						for (let i = 0; i < items.length; i++) {
							if (items[i].tier <= 1) tier01Count++;
						}
						cachedElOverlaps = {
							items,
							tier01Count,
							hasShadowDom: elHasShadowDom,
							hasUnboundedPseudo: ov.hasUnboundedPseudo,
						};
						return cachedElOverlaps;
					};

					const hasOverlayIntersection = (L, T, R, B) => {
						const { items } = getElOverlaps();
						for (let i = 0; i < items.length; i++) {
							const it = items[i];
							const r = it.rect;
							if (r.right > L && r.left < R && r.bottom > T && r.top < B) {
								if (it.tier === 3 && !clip.hasStackingContextAncestor && it.node) {
									let inTrappedStack = false;
									for (
										let anc = it.isPseudo ? it.node : it.node.parentElement;
										anc && anc.nodeType === 1 && anc !== document.documentElement;
										anc = anc.parentElement
									) {
										if (createsStackingContext(window.getComputedStyle(anc), anc)) {
											inTrappedStack = true;
											break;
										}
									}
									if (!inTrappedStack) continue;
								}
								return true;
							}
						}
						return false;
					};

					const tTargetStart = performance.now();
					const vvScale0 = window.visualViewport ? window.visualViewport.scale : 1;
					const isNonZoomed = !(Number.isFinite(vvScale0) && vvScale0 < 0.9995);
					let targetDeadline = tTargetStart + (isNonZoomed ? 4200 : 8500);
					const minEarlyGap = clip.hasRoundedClip ? 28.0 : 43.95;
					const minAxisGap = clip.hasRoundedClip ? 27.5 : 43.5;

					const collectDomBlockedPts = () => {
						if (domBlockedCollected) return;
						domBlockedCollected = true;
						const { items } = getElOverlaps();
						const collectDeadline =
							totalTargets === 1 && items.length >= 800 && isNonZoomed
								? Math.min(targetDeadline - 450, tEvalStart + 2800)
								: Math.min(targetDeadline - 350, performance.now() + 3650);
						let missBudget01 = 2000;
						let missBudget23 = 600;
						let hitBudget = Math.max(0, 3000 - blockedPts.length);
						let realProbes = 0;
						const seenBoxes = new Set();
						const probe = (x, y, tier) => {
							if (hitBudget <= 0) return false;
							if (tier <= 1 ? missBudget01 <= 0 : missBudget23 <= 0) return false;
							const before = realEfpCalls;
							const ok = hitsAt(x, y);
							if (realEfpCalls > before) {
								realProbes++;
								if (ok) {
									if (tier <= 1) missBudget01--;
									else missBudget23--;
								} else {
									hitBudget--;
								}
							}
							return ok;
						};
						const probeItem = (item, pxOverride = null, pyOverride = null) => {
							const { oL, oR, oT, oB, oW, oH, tier } = item;
							if (tier <= 1 ? missBudget01 <= 0 : missBudget23 <= 0) return;
							const boxKey = `${Math.round(oL * 2)},${Math.round(oT * 2)},${Math.round(oR * 2)},${Math.round(oB * 2)}`;
							if (seenBoxes.has(boxKey)) return;
							seenBoxes.add(boxKey);
							if (oW <= 43.9 && oH <= 43.9) {
								const midOk = probe(
									pxOverride !== null ? pxOverride : (oL + oR) / 2,
									pyOverride !== null ? pyOverride : (oT + oB) / 2,
									tier,
								);
								if (!midOk && pxOverride === null && pyOverride === null && hitBudget > 0 && performance.now() <= collectDeadline) {
									if (oW >= 16 && oH <= 16) {
										const cy = (oT + oB) / 2;
										probe(oL + Math.min(0.5, oW / 4), cy, tier);
										if (hitBudget > 0) probe(oR - Math.min(0.5, oW / 4), cy, tier);
									} else if (oH >= 16 && oW <= 16) {
										const cx = (oL + oR) / 2;
										probe(cx, oT + Math.min(0.5, oH / 4), tier);
										if (hitBudget > 0) probe(cx, oB - Math.min(0.5, oH / 4), tier);
									}
								}
							} else if (Math.min(oW, oH) <= 43.9) {
								const midOk = probe((oL + oR) / 2, (oT + oB) / 2, tier);
								if (!midOk && hitBudget > 0) {
									if (oW <= oH) {
										const cx = (oL + oR) / 2;
										const n = Math.min(hitBudget, Math.max(2, Math.ceil(oH / 36)));
										for (let k = 0; k < n && hitBudget > 0; k++) {
											probe(cx, oT + ((k + 0.5) / n) * oH, tier);
										}
									} else {
										const cy = (oT + oB) / 2;
										const n = Math.min(hitBudget, Math.max(2, Math.ceil(oW / 36)));
										for (let k = 0; k < n && hitBudget > 0; k++) {
											probe(oL + ((k + 0.5) / n) * oW, cy, tier);
										}
									}
								}
							} else {
								probe((oL + oR) / 2, (oT + oB) / 2, tier);
							}
						};

						const buildStridedTierIndices = () => {
							const outIdx = [];
							let start = 0;
							while (start < items.length) {
								const t = items[start].tier;
								let end = start + 1;
								while (end < items.length && items[end].tier === t) end++;
								const len = end - start;
								if (len <= 200) {
									for (let idx = start; idx < end; idx++) outIdx.push(idx);
								} else {
									const stride = Math.max(2, Math.ceil(len / 200));
									for (let off = 0; off < stride; off++) {
										for (let idx = start + off; idx < end; idx += stride) outIdx.push(idx);
									}
								}
								start = end;
							}
							return outIdx;
						};

						const deferredIdx = [];
						let ranThinnedPass = false;
						if (items.length >= 800) {
							const xBinsMap = new Map();
							const yBinsMap = new Map();
							const itemBinMeta = new Array(items.length);
							for (let i = 0; i < items.length; i++) {
								const it = items[i];
								if (it.tier <= 1 && it.oW <= 43.9 && it.oH <= 43.9) {
									const cx = (it.oL + it.oR) / 2;
									const cy = (it.oT + it.oB) / 2;
									const xKey = Math.round(cx);
									const yKey = Math.round(cy);
									itemBinMeta[i] = { xKey, yKey };
									let xb = xBinsMap.get(xKey);
									if (!xb) {
										xb = { key: xKey, maxL: it.oL, minR: it.oR };
										xBinsMap.set(xKey, xb);
									} else {
										if (it.oL > xb.maxL) xb.maxL = it.oL;
										if (it.oR < xb.minR) xb.minR = it.oR;
									}
									let yb = yBinsMap.get(yKey);
									if (!yb) {
										yb = { key: yKey, maxT: it.oT, minB: it.oB };
										yBinsMap.set(yKey, yb);
									} else {
										if (it.oT > yb.maxT) yb.maxT = it.oT;
										if (it.oB < yb.minB) yb.minB = it.oB;
									}
								}
							}
							const planAxis = (binsMap, isX) => {
								const bins = Array.from(binsMap.values()).sort((a, b) => a.key - b.key);
								const keep = new Map();
								const getPos = (b, mode) => {
									const lo = isX ? b.maxL : b.maxT;
									const hi = isX ? b.minR : b.minB;
									if (hi <= lo) return null;
									const w = hi - lo;
									const eps = Math.min(0.15, w * 0.25);
									if (mode === "low") return lo + eps;
									if (mode === "high") return hi - eps;
									return (lo + hi) / 2;
								};
								let idx = 0;
								let prevProbe = null;
								while (idx < bins.length) {
									const curPosMid = getPos(bins[idx], "mid");
									if (curPosMid === null) {
										keep.set(bins[idx].key, null);
										idx++;
										continue;
									}
									if (idx + 2 < bins.length) {
										const pHigh = getPos(bins[idx], "high");
										const pNextLow = getPos(bins[idx + 2], "low");
										if (
											pHigh !== null &&
											pNextLow !== null &&
											(prevProbe === null || pHigh - prevProbe < minAxisGap) &&
											pNextLow - pHigh < minAxisGap
										) {
											keep.set(bins[idx].key, pHigh);
											keep.set(bins[idx + 2].key, pNextLow);
											prevProbe = pNextLow;
											idx += 3;
											continue;
										}
									}
									const chosen = curPosMid;
									keep.set(bins[idx].key, chosen);
									prevProbe = chosen;
									idx++;
								}
								return keep;
							};
							const keepX = planAxis(xBinsMap, true);
							const keepY = planAxis(yBinsMap, false);
							if (keepX.size >= 15 && keepY.size >= 15) {
								ranThinnedPass = true;
								const order = buildStridedTierIndices();
								for (let oi = 0; oi < order.length && hitBudget > 0; oi++) {
									if ((realProbes & 63) === 0 && performance.now() > collectDeadline) break;
									const i = order[oi];
									const meta = itemBinMeta[i];
									if (!meta) {
										probeItem(items[i]);
									} else if (keepX.has(meta.xKey) && keepY.has(meta.yKey)) {
										probeItem(items[i], keepX.get(meta.xKey), keepY.get(meta.yKey));
									} else {
										deferredIdx.push(i);
									}
									if (
										realProbes >= 512 &&
										(realProbes & 255) === 0 &&
										!blockedPtsHasMinGap(visLeft, visTop, visRight, visBottom, minEarlyGap)
									) {
										return;
									}
								}
							}
						}

						if (!ranThinnedPass) {
							const order = buildStridedTierIndices();
							for (let oi = 0; oi < order.length && hitBudget > 0; oi++) {
								if ((realProbes & 63) === 0 && performance.now() > collectDeadline) break;
								probeItem(items[order[oi]]);
								if (
									realProbes >= 512 &&
									(realProbes & 255) === 0 &&
									!blockedPtsHasMinGap(visLeft, visTop, visRight, visBottom, minEarlyGap)
								) {
									return;
								}
							}
						} else if (
							deferredIdx.length > 0 &&
							hitBudget > 0 &&
							performance.now() <= collectDeadline &&
							blockedPtsHasMinGap(visLeft, visTop, visRight, visBottom, minEarlyGap)
						) {
							for (let di = 0; di < deferredIdx.length && hitBudget > 0; di++) {
								if ((realProbes & 63) === 0 && performance.now() > collectDeadline) break;
								probeItem(items[deferredIdx[di]]);
								if (
									realProbes >= 512 &&
									(realProbes & 255) === 0 &&
									!blockedPtsHasMinGap(visLeft, visTop, visRight, visBottom, minEarlyGap)
								) {
									return;
								}
							}
						}
					};

					const sweepPts44x44 = (L, T, R, B, sourcePts, collectGaps, minSpan = 43.95) => {
						if (R - L < minSpan || B - T < minSpan) return collectGaps ? [] : false;
						if (sourcePts.length === 0) {
							return collectGaps ? [{ left: L, top: T, right: R, bottom: B, w: R - L, h: B - T }] : true;
						}
						const pts = [];
						for (let i = 0; i < sourcePts.length; i++) {
							const p = sourcePts[i];
							if (p.x > L && p.x < R && p.y > T && p.y < B) {
								pts.push(p);
							}
						}
						if (pts.length === 0) {
							return collectGaps ? [{ left: L, top: T, right: R, bottom: B, w: R - L, h: B - T }] : true;
						}
						pts.sort((a, b) => a.y - b.y || a.x - b.x);
						const xsRaw = [L, R];
						for (let i = 0; i < pts.length; i++) xsRaw.push(pts[i].x);
						xsRaw.sort((a, b) => a - b);
						const ux = [xsRaw[0]];
						for (let i = 1; i < xsRaw.length; i++) {
							if (xsRaw[i] > ux[ux.length - 1]) ux.push(xsRaw[i]);
						}
						const M = ux.length;
						const xIdx = new Int32Array(pts.length);
						for (let i = 0; i < pts.length; i++) {
							const x = pts[i].x;
							let lo = 0;
							let hi = M - 1;
							while (lo <= hi) {
								const mid = (lo + hi) >> 1;
								if (ux[mid] < x) lo = mid + 1;
								else hi = mid - 1;
							}
							xIdx[i] = lo;
						}
						let sz = 1;
						while (sz < M) sz <<= 1;
						const firstX = new Float64Array(sz * 2).fill(Infinity);
						const lastX = new Float64Array(sz * 2).fill(-Infinity);
						const maxGap = new Float64Array(sz * 2);
						const gapL = new Float64Array(sz * 2);
						const gapR = new Float64Array(sz * 2);
						const counts = new Int32Array(M);
						const pull = (k) => {
							const lc = k << 1;
							const rc = lc | 1;
							const lf = firstX[lc];
							const rf = firstX[rc];
							const ll = lastX[lc];
							const rl = lastX[rc];
							firstX[k] = lf < Infinity ? lf : rf;
							lastX[k] = rl > -Infinity ? rl : ll;
							let best = maxGap[lc];
							let bL = gapL[lc];
							let bR = gapR[lc];
							if (maxGap[rc] > best) {
								best = maxGap[rc];
								bL = gapL[rc];
								bR = gapR[rc];
							}
							if (ll > -Infinity && rf < Infinity) {
								const cross = rf - ll;
								if (cross > best) {
									best = cross;
									bL = ll;
									bR = rf;
								}
							}
							maxGap[k] = best;
							gapL[k] = bL;
							gapR[k] = bR;
						};
						const setLeaf = (idx, active) => {
							const k = sz + idx;
							if (active) {
								firstX[k] = ux[idx];
								lastX[k] = ux[idx];
							} else {
								firstX[k] = Infinity;
								lastX[k] = -Infinity;
							}
							for (let p = k >> 1; p >= 1; p >>= 1) pull(p);
						};
						counts[0] = 1;
						counts[M - 1] = 1;
						firstX[sz] = ux[0];
						lastX[sz] = ux[0];
						firstX[sz + M - 1] = ux[M - 1];
						lastX[sz + M - 1] = ux[M - 1];
						for (let k = sz - 1; k >= 1; k--) pull(k);

						const tops = [T];
						for (let i = 0; i < pts.length; i++) {
							const py = pts[i].y;
							if (py > tops[tops.length - 1]) tops.push(py);
						}
						const gaps = collectGaps ? [] : null;
						let lo = 0;
						let hi = 0;
						for (let ti = 0; ti < tops.length; ti++) {
							const topY = tops[ti];
							if (B - topY < minSpan) break;
							while (lo < pts.length && pts[lo].y <= topY) {
								const idx = xIdx[lo++];
								if (--counts[idx] === 0) setLeaf(idx, false);
							}
							while (hi < pts.length && pts[hi].y < topY + minSpan) {
								const idx = xIdx[hi++];
								if (++counts[idx] === 1) setLeaf(idx, true);
							}
							if (maxGap[1] >= minSpan) {
								if (!collectGaps) return true;
								const botY = hi < pts.length ? pts[hi].y : B;
								const gl = gapL[1];
								const gr = gapR[1];
								const prev = gaps.length > 0 ? gaps[gaps.length - 1] : null;
								if (
									!prev ||
									Math.abs(prev.left - gl) > 1 ||
									Math.abs(prev.right - gr) > 1 ||
									topY >= prev.bottom - 0.5
								) {
									gaps.push({ left: gl, top: topY, right: gr, bottom: botY, w: gr - gl, h: botY - topY });
									if (gaps.length >= 16) break;
								} else if (botY > prev.bottom) {
									prev.bottom = botY;
									prev.h = botY - prev.top;
								}
							}
						}
						return collectGaps ? gaps : false;
					};

					const blockedPtsHasMinGap = (L, T, R, B, minSpan = 43.95) =>
						sweepPts44x44(L, T, R, B, blockedPts, false, minSpan);
					const blockedPtsHas44x44Gap = (L, T, R, B) => sweepPts44x44(L, T, R, B, blockedPts, false, 43.95);
					const extractBlockedPtsGaps = (L, T, R, B, pts = blockedPts) => sweepPts44x44(L, T, R, B, pts, true, 43.95);

					const refinePredicate = (lo, hi, pred, wantMin) => {
						let a = lo;
						let b = hi;
						for (let k = 0; k < 8; k++) {
							const mid = (a + b) / 2;
							if (pred(mid)) {
								if (wantMin) b = mid;
								else a = mid;
							} else {
								if (wantMin) a = mid;
								else b = mid;
							}
						}
						return wantMin ? b : a;
					};

					const maxContigLineSpan = (from, to, sampleFn) => {
						const len = to - from;
						if (len <= 0) return { maxSpan: 0, bestStart: from, bestEnd: from };
						const step = len <= 400 ? 1 : len / 400;
						const n = Math.max(2, Math.ceil(len / step));
						const ds = len / n;
						let maxSpan = 0;
						let bestStart = from;
						let bestEnd = from;
						let runStart = null;
						for (let k = 0; k < n; k++) {
							if ((k & 31) === 0 && performance.now() > targetDeadline) {
								return { maxSpan: 0, bestStart: from, bestEnd: from };
							}
							const pos = from + (k + 0.5) * ds;
							if (sampleFn(pos)) {
								if (runStart === null) runStart = from + k * ds;
								const runEnd = from + (k + 1) * ds;
								const span = runEnd - runStart;
								if (span > maxSpan) {
									maxSpan = span;
									bestStart = runStart;
									bestEnd = runEnd;
								}
							} else {
								runStart = null;
							}
						}
						return { maxSpan, bestStart, bestEnd };
					};

					const subRectCache = new Map();
					const checkSubRectHairline = (left, top, right, bottom) => {
						const w = right - left;
						const h = bottom - top;
						if (w < 43.95 || h < 43.95) return false;
						if (performance.now() > targetDeadline) return false;
						const cacheKey = `${Math.round(left * 100)},${Math.round(top * 100)},${Math.round(right * 100)},${Math.round(bottom * 100)}`;
						if (subRectCache.has(cacheKey)) return subRectCache.get(cacheKey);

						const cacheReturn = (val) => {
							subRectCache.set(cacheKey, val);
							return val;
						};

						// Include fractional boundary strips [left, Math.ceil(left)] and [top, Math.ceil(top)]
						// when > 0.0001px wide so subpixel-offset occlusions are never skipped.
						const leftFrac = Math.ceil(left) - left > 0.0001;
						const rightFrac = right - Math.floor(right) > 0.0001;
						const topFrac = Math.ceil(top) - top > 0.0001;
						const bottomFrac = bottom - Math.floor(bottom) > 0.0001;

						const ix0 = leftFrac ? Math.floor(left) : Math.ceil(left);
						const ix1 = rightFrac ? Math.floor(right) : Math.floor(right) - 1;
						const iy0 = topFrac ? Math.floor(top) : Math.ceil(top);
						const iy1 = bottomFrac ? Math.floor(bottom) : Math.floor(bottom) - 1;
						const nx = ix1 - ix0 + 1;
						const ny = iy1 - iy0 + 1;
						if (nx <= 0 || ny <= 0) return cacheReturn(false);

						const boundLeft0 = Math.max(left, ix0);
						const boundRightMax = Math.min(right, ix1 + 1);
						const boundTop0 = Math.max(top, iy0);
						const boundBottomMax = Math.min(bottom, iy1 + 1);
						if (boundRightMax - boundLeft0 < 43.95 || boundBottomMax - boundTop0 < 43.95) {
							return cacheReturn(false);
						}

						const pxCoords = new Float64Array(nx);
						for (let i = 0; i < nx; i++) {
							const ix = ix0 + i;
							const cL = Math.max(left, ix);
							const cR = Math.min(right, ix + 1);
							pxCoords[i] = (cL + cR) / 2;
						}
						const pyCoords = new Float64Array(ny);
						for (let j = 0; j < ny; j++) {
							const iy = iy0 + j;
							const rT = Math.max(top, iy);
							const rB = Math.min(bottom, iy + 1);
							pyCoords[j] = (rT + rB) / 2;
						}

						const buildIndices = (len, step) => {
							if (step <= 1) {
								const arr = new Int32Array(len);
								for (let k = 0; k < len; k++) arr[k] = k;
								return arr;
							}
							const list = [];
							for (let k = 0; k < len; k += step) list.push(k);
							if (list[list.length - 1] !== len - 1) list.push(len - 1);
							return Int32Array.from(list);
						};

						const ovInfo = getElOverlaps();
						const vvScale = window.visualViewport ? window.visualViewport.scale : 1;
						const allowRectPure = ovInfo.tier01Count >= 600 || (Number.isFinite(vvScale) && vvScale < 0.9995);
						const isRectPure =
							allowRectPure &&
							!(el instanceof SVGElement) &&
							!clip.hasRoundedClip &&
							!clip.hasAnyClipPath &&
							!clip.hasAnyMask &&
							!clip.hasSkewOrRotation &&
							!clip.hasNegZAncestor &&
							!ovInfo.hasShadowDom &&
							!ovInfo.hasUnboundedPseudo &&
							el.getClientRects().length === 1;
						if (isRectPure && !hasOverlayIntersection(left, top, right, bottom)) {
							const s8x = buildIndices(nx, 8);
							const s8y = buildIndices(ny, 8);
							let ok8 = true;
							for (let r = 0; r < s8y.length && ok8; r++) {
								const py = pyCoords[s8y[r]];
								for (let c = 0; c < s8x.length; c++) {
									if (!hitsAt(pxCoords[s8x[c]], py)) {
										ok8 = false;
										break;
									}
								}
							}
							return cacheReturn(ok8);
						}

						const coreL = boundRightMax - 43.95;
						const coreR = boundLeft0 + 43.95;
						const coreT = boundBottomMax - 43.95;
						const coreB = boundTop0 + 43.95;
						if (w >= 50 && h >= 50 && w <= 120 && h <= 120 && !(coreL < coreR && coreT < coreB)) {
							const cx0 = Math.max(left, Math.floor((left + right) / 2 - 22.5));
							const cy0 = Math.max(top, Math.floor((top + bottom) / 2 - 22.5));
							const cx1 = Math.min(right, cx0 + 45);
							const cy1 = Math.min(bottom, cy0 + 45);
							if (cx1 - cx0 >= 44 && cy1 - cy0 >= 44 && checkSubRectHairline(cx0, cy0, cx1, cy1)) {
								return cacheReturn(true);
							}
						}

						// 1. Mandatory intersection core quick-reject when w < 87.9 && h < 87.9:
						//    Every 43.95x43.95 rectangle must contain [coreL, coreR] x [coreT, coreB].
						//    Check coarse step=4 -> step=2 -> step=1 before outer scans.
						if (coreL < coreR && coreT < coreB) {
							let ci0 = -1;
							let ci1 = -1;
							for (let i = 0; i < nx; i++) {
								if (pxCoords[i] >= coreL && pxCoords[i] <= coreR) {
									if (ci0 === -1) ci0 = i;
									ci1 = i;
								}
							}
							let cj0 = -1;
							let cj1 = -1;
							for (let j = 0; j < ny; j++) {
								if (pyCoords[j] >= coreT && pyCoords[j] <= coreB) {
									if (cj0 === -1) cj0 = j;
									cj1 = j;
								}
							}
							if (ci0 !== -1 && cj0 !== -1) {
								for (const coreStep of [4, 2, 1]) {
									for (let j = cj0; j <= cj1; j += coreStep) {
										if ((j & 3) === 0 && performance.now() > targetDeadline) return false;
										const py = pyCoords[j];
										for (let i = ci0; i <= ci1; i += coreStep) {
											if (!hitsAt(pxCoords[i], py)) return cacheReturn(false);
										}
									}
								}
							}
						}

						// 2. Ultra-fast coarse 8px mandatory cut-line check for larger rects/tiles (>= 87.9):
						//    Any 43.95x43.95 clear rect must cross cut lines spaced <= 43.4px.
						const cx8 = buildIndices(nx, 8);
						const cy8 = buildIndices(ny, 8);
						if (!(coreL < coreR && coreT < coreB)) {
							let curTop = boundTop0;
							let allYPruned = true;
							while (boundBottomMax - curTop >= 43.95) {
								if (performance.now() > targetDeadline) return false;
								const yTarget = Math.min(boundBottomMax - 0.5, curTop + 43.4);
								const jCut = Math.max(0, Math.min(ny - 1, Math.floor(yTarget - iy0)));
								const py = pyCoords[jCut];
								let maxRun = 0;
								let runStart = null;
								for (let c = 0; c < cx8.length; c++) {
									if (hitsAt(pxCoords[cx8[c]], py)) {
										if (runStart === null) runStart = c === 0 ? boundLeft0 : pxCoords[cx8[c - 1]];
										const runEnd = c === cx8.length - 1 ? boundRightMax : pxCoords[cx8[c + 1]];
										if (runEnd - runStart > maxRun) maxRun = runEnd - runStart;
									} else {
										runStart = null;
									}
								}
								if (maxRun >= 43.95) {
									allYPruned = false;
									break;
								}
								if (py <= curTop) {
									allYPruned = false;
									break;
								}
								curTop = py;
							}
							if (allYPruned) return cacheReturn(false);

							let curLeft = boundLeft0;
							let allXPruned = true;
							while (boundRightMax - curLeft >= 43.95) {
								const xTarget = Math.min(boundRightMax - 0.5, curLeft + 43.4);
								const iCut = Math.max(0, Math.min(nx - 1, Math.floor(xTarget - ix0)));
								const px = pxCoords[iCut];
								let maxRun = 0;
								let runStart = null;
								for (let r = 0; r < cy8.length; r++) {
									if (hitsAt(px, pyCoords[cy8[r]])) {
										if (runStart === null) runStart = r === 0 ? boundTop0 : pyCoords[cy8[r - 1]];
										const runEnd = r === cy8.length - 1 ? boundBottomMax : pyCoords[cy8[r + 1]];
										if (runEnd - runStart > maxRun) maxRun = runEnd - runStart;
									} else {
										runStart = null;
									}
								}
								if (maxRun >= 43.95) {
									allXPruned = false;
									break;
								}
								if (px <= curLeft) {
									allXPruned = false;
									break;
								}
								curLeft = px;
							}
							if (allXPruned) return cacheReturn(false);
						}

						// 3. Hierarchical 2D largest-empty-rectangle check: coarse 2px pre-filter then exact 1px check.
						const runGridLERT = (step) => {
							const xIdx = buildIndices(nx, step);
							const yIdx = buildIndices(ny, step);
							const mx = xIdx.length;
							const my = yIdx.length;
							const rectHeights = new Int32Array(mx);
							let anyBlocked = false;
							let segTop = boundTop0;

							for (let r = 0; r < my; r++) {
								if ((r & 3) === 0 && performance.now() > targetDeadline) return false;
								const j = yIdx[r];
								const py = pyCoords[j];
								let maxRowSpan = 0;
								let runStart = null;
								for (let c = 0; c < mx; c++) {
									const i = xIdx[c];
									if (hitsAt(pxCoords[i], py)) {
										rectHeights[c] += 1;
										if (runStart === null) {
											runStart = step === 1 ? (i === 0 ? boundLeft0 : ix0 + i) : c === 0 ? boundLeft0 : pxCoords[xIdx[c - 1]];
										}
										const runEnd =
											step === 1
												? i === nx - 1
													? boundRightMax
													: ix0 + i + 1
												: c === mx - 1
													? boundRightMax
													: pxCoords[xIdx[c + 1]];
										if (runEnd - runStart > maxRowSpan) maxRowSpan = runEnd - runStart;
									} else {
										rectHeights[c] = 0;
										anyBlocked = true;
										runStart = null;
									}
								}
								const curRowBottom =
									step === 1
										? j === ny - 1
											? boundBottomMax
											: iy0 + j + 1
										: r === my - 1
											? boundBottomMax
											: pyCoords[yIdx[r + 1]];
								if (!anyBlocked) {
									if (curRowBottom - boundTop0 >= 43.95 && boundRightMax - boundLeft0 >= 43.95) {
										return true;
									}
									continue;
								}
								if (curRowBottom - boundTop0 >= 43.9 || r === my - 1) {
									const stack = [];
									for (let c = 0; c <= mx; c++) {
										const curH = c === mx ? 0 : rectHeights[c];
										let startCol = c;
										while (stack.length > 0 && stack[stack.length - 1].h > curH) {
											const topBar = stack.pop();
											startCol = topBar.start;
											if (topBar.h > 0) {
												const c0 = startCol;
												const c1 = c - 1;
												const r0 = r - topBar.h + 1;
												const r1 = r;
												const leftBound =
													step === 1
														? xIdx[c0] === 0
															? boundLeft0
															: ix0 + xIdx[c0]
														: c0 === 0
															? boundLeft0
															: pxCoords[xIdx[c0 - 1]];
												const rightBound =
													step === 1
														? xIdx[c1] === nx - 1
															? boundRightMax
															: ix0 + xIdx[c1] + 1
														: c1 === mx - 1
															? boundRightMax
															: pxCoords[xIdx[c1 + 1]];
												const topBound =
													step === 1
														? yIdx[r0] === 0
															? boundTop0
															: iy0 + yIdx[r0]
														: r0 === 0
															? boundTop0
															: pyCoords[yIdx[r0 - 1]];
												const bottomBound =
													step === 1
														? yIdx[r1] === ny - 1
															? boundBottomMax
															: iy0 + yIdx[r1] + 1
														: r1 === my - 1
															? boundBottomMax
															: pyCoords[yIdx[r1 + 1]];
												if (rightBound - leftBound >= 43.95 && bottomBound - topBound >= 43.95) {
													return true;
												}
											}
										}
										if (stack.length === 0 || stack[stack.length - 1].h < curH) {
											stack.push({ start: startCol, h: curH });
										}
									}
								}
								if (maxRowSpan < 43.95) {
									segTop = py;
									if (boundBottomMax - segTop < 43.95) return false;
								}
							}
							return !anyBlocked;
						};

						if (nx >= 32 && ny >= 32 && !runGridLERT(8)) {
							return performance.now() > targetDeadline ? false : cacheReturn(false);
						}
						if (nx >= 16 && ny >= 16 && !runGridLERT(4)) {
							return performance.now() > targetDeadline ? false : cacheReturn(false);
						}
						if (nx >= 12 && ny >= 12 && !runGridLERT(3)) {
							return performance.now() > targetDeadline ? false : cacheReturn(false);
						}
						if (!runGridLERT(2)) {
							return performance.now() > targetDeadline ? false : cacheReturn(false);
						}
						const r1Ok = runGridLERT(1);
						return performance.now() > targetDeadline && !r1Ok ? false : cacheReturn(r1Ok);
					};

					const rectPassesHairlineCheck = (r) => {
						if (!r || r.w < 43.95 || r.h < 43.95) return false;
						if (performance.now() > targetDeadline) return false;
						if (!blockedPtsHas44x44Gap(r.left, r.top, r.right, r.bottom)) return false;
						if (r.w <= 120 && r.h <= 120) {
							return checkSubRectHairline(r.left, r.top, r.right, r.bottom);
						}
						const tileSize = 88;
						const tileStep = 44;
						const xRanges = [];
						if (r.w <= tileSize) {
							xRanges.push([r.left, r.right]);
						} else {
							for (let k = 0; ; k++) {
								const rawX0 = r.left + k * tileStep;
								if (rawX0 > r.right - 43.95) break;
								const x0 = Math.min(rawX0, r.right - tileSize);
								const x1 = Math.min(r.right, x0 + tileSize);
								if (x1 - x0 >= 43.95) {
									if (xRanges.length === 0 || xRanges[xRanges.length - 1][0] !== x0) {
										xRanges.push([x0, x1]);
									}
								}
								if (x1 >= r.right) break;
							}
						}
						const yRanges = [];
						if (r.h <= tileSize) {
							yRanges.push([r.top, r.bottom]);
						} else {
							for (let m = 0; ; m++) {
								const rawY0 = r.top + m * tileStep;
								if (rawY0 > r.bottom - 43.95) break;
								const y0 = Math.min(rawY0, r.bottom - tileSize);
								const y1 = Math.min(r.bottom, y0 + tileSize);
								if (y1 - y0 >= 43.95) {
									if (yRanges.length === 0 || yRanges[yRanges.length - 1][0] !== y0) {
										yRanges.push([y0, y1]);
									}
								}
								if (y1 >= r.bottom) break;
							}
						}
						for (const [y0, y1] of yRanges) {
							for (const [x0, x1] of xRanges) {
								if (performance.now() > targetDeadline) return false;
								if (!blockedPtsHas44x44Gap(x0, y0, x1, y1)) continue;
								if (checkSubRectHairline(x0, y0, x1, y1)) return true;
							}
						}
						return false;
					};

					const checkLargeRefinedRect = (r) => {
						if (!r || r.w < 43.95 || r.h < 43.95) return false;
						if (performance.now() > targetDeadline) return false;
						if (!blockedPtsHas44x44Gap(r.left, r.top, r.right, r.bottom)) return false;

						const probeR = Math.min(r.right, r.left + 46);
						const probeB = Math.min(r.bottom, r.top + 46);
						if (
							probeR - r.left >= 43.95 &&
							probeB - r.top >= 43.95 &&
							blockedPtsHas44x44Gap(r.left, r.top, probeR, probeB)
						) {
							if (checkSubRectHairline(r.left, r.top, probeR, probeB)) return true;
						}
						if (!blockedPtsHas44x44Gap(r.left, r.top, r.right, r.bottom)) return false;

						if (blockedPts.length > 0) {
							const bpGaps = extractBlockedPtsGaps(r.left, r.top, r.right, r.bottom);
							for (const g of bpGaps) {
								if (performance.now() > targetDeadline) return false;
								const tryL = g.right - Math.ceil(g.left) >= 43.95 ? Math.ceil(g.left) : g.left;
								const tryT = g.bottom - Math.ceil(g.top) >= 43.95 ? Math.ceil(g.top) : g.top;
								const prR = Math.min(g.right, tryL + 46);
								const prB = Math.min(g.bottom, tryT + 46);
								if (checkSubRectHairline(tryL, tryT, prR, prB)) return true;
								if (g.w <= 120 && g.h <= 120) {
									if (checkSubRectHairline(g.left, g.top, g.right, g.bottom)) return true;
								} else {
									if (
										checkSubRectHairline(
											g.left,
											g.top,
											Math.min(g.right, g.left + 46),
											Math.min(g.bottom, g.top + 46),
										)
									) {
										return true;
									}
									if (rectPassesHairlineCheck(g)) return true;
								}
							}
						}

						// Subdivide >120x120 candidates at <=20px spacing (plus blockedPts cut-lines) so 1-39px dividers split cleanly
						const baseCols = Math.min(52, Math.max(12, Math.ceil(r.w / 20)));
						const baseRows = Math.min(52, Math.max(12, Math.ceil(r.h / 20)));
						const sxsRaw = [];
						for (let i = 0; i < baseCols; i++) sxsRaw.push(r.left + ((i + 0.5) / baseCols) * r.w);
						const sysRaw = [];
						for (let j = 0; j < baseRows; j++) sysRaw.push(r.top + ((j + 0.5) / baseRows) * r.h);
						if (blockedPts.length > 0) {
							const bxSet = new Set();
							const bySet = new Set();
							for (let bi = 0; bi < blockedPts.length; bi++) {
								const bp = blockedPts[bi];
								if (bp.x > r.left + 0.05 && bp.x < r.right - 0.05 && bxSet.size < 64) {
									const kx = Math.round(bp.x * 2);
									if (!bxSet.has(kx)) {
										bxSet.add(kx);
										sxsRaw.push(bp.x);
									}
								}
								if (bp.y > r.top + 0.05 && bp.y < r.bottom - 0.05 && bySet.size < 64) {
									const ky = Math.round(bp.y * 2);
									if (!bySet.has(ky)) {
										bySet.add(ky);
										sysRaw.push(bp.y);
									}
								}
							}
						}
						sxsRaw.sort((a, b) => a - b);
						sysRaw.sort((a, b) => a - b);
						const sxs = [];
						for (let i = 0; i < sxsRaw.length; i++) {
							if (sxs.length === 0 || sxsRaw[i] - sxs[sxs.length - 1] > 0.05) sxs.push(sxsRaw[i]);
						}
						const sys = [];
						for (let j = 0; j < sysRaw.length; j++) {
							if (sys.length === 0 || sysRaw[j] - sys[sys.length - 1] > 0.05) sys.push(sysRaw[j]);
						}
						const subCols = sxs.length;
						const subRows = sys.length;
						const sGrid = new Array(subRows);
						for (let j = 0; j < subRows; j++) {
							if (performance.now() > targetDeadline) return false;
							sGrid[j] = sxs.map((x) => hitsAt(x, sys[j]));
						}
						const sHeights = new Array(subCols).fill(0);
						const sCands = new Map();
						for (let j = 0; j < subRows; j++) {
							for (let i = 0; i < subCols; i++) {
								sHeights[i] = sGrid[j][i] ? sHeights[i] + 1 : 0;
							}
							const stack = [];
							for (let i = 0; i <= subCols; i++) {
								const curH = i === subCols ? 0 : sHeights[i];
								let startCol = i;
								while (stack.length > 0 && stack[stack.length - 1].h > curH) {
									const topBar = stack.pop();
									startCol = topBar.start;
									if (topBar.h > 0) {
										const c0 = startCol;
										const c1 = i - 1;
										const r0 = j - topBar.h + 1;
										const r1 = j;
										const rawL = c0 === 0 ? r.left : sxs[c0 - 1];
										const rawR = c1 === subCols - 1 ? r.right : sxs[c1 + 1];
										const rawT = r0 === 0 ? r.top : sys[r0 - 1];
										const rawB = r1 === subRows - 1 ? r.bottom : sys[r1 + 1];
										if (Math.min(rawR - rawL, rawB - rawT) >= 43.95) {
											const key = `${c0},${r0},${c1},${r1}`;
											if (!sCands.has(key)) {
												sCands.set(key, {
													c0,
													r0,
													c1,
													r1,
													rawL,
													rawR,
													rawT,
													rawB,
													rawArea: (rawR - rawL) * (rawB - rawT),
												});
											}
										}
									}
								}
								if (stack.length === 0 || stack[stack.length - 1].h < curH) {
									stack.push({ start: startCol, h: curH });
								}
							}
						}

						const subLarge = [];
						const seenSub = new Set();
						const orderedSub = Array.from(sCands.values()).sort((a, b) => a.rawArea - b.rawArea);
						for (const sc of orderedSub) {
							if (performance.now() > targetDeadline) return false;
							if (!blockedPtsHas44x44Gap(sc.rawL, sc.rawT, sc.rawR, sc.rawB)) continue;
							const { c0, r0, c1, r1 } = sc;
							const yMid = (sys[r0] + sys[r1]) / 2;
							const xMid = (sxs[c0] + sxs[c1]) / 2;
							const ySL = r0 === r1 || hitsAt(sxs[c0], yMid) ? [sys[r0], yMid, sys[r1]] : [sys[r0], sys[r1]];
							const ySR = r0 === r1 || hitsAt(sxs[c1], yMid) ? [sys[r0], yMid, sys[r1]] : [sys[r0], sys[r1]];
							const xST = c0 === c1 || hitsAt(xMid, sys[r0]) ? [sxs[c0], xMid, sxs[c1]] : [sxs[c0], sxs[c1]];
							const xSB = c0 === c1 || hitsAt(xMid, sys[r1]) ? [sxs[c0], xMid, sxs[c1]] : [sxs[c0], sxs[c1]];
							const colL = (x) => ySL.every((y) => hitsAt(x, y));
							const colR = (x) => ySR.every((y) => hitsAt(x, y));
							const rowT = (y) => xST.every((x) => hitsAt(x, y));
							const rowB = (y) => xSB.every((x) => hitsAt(x, y));
							const leftE =
								c0 === 0
									? colL(r.left + 0.25)
										? r.left
										: refinePredicate(r.left + 0.25, sxs[0], colL, true)
									: refinePredicate(sxs[c0 - 1], sxs[c0], colL, true);
							let sr = null;
							if ((c1 === subCols - 1 ? r.right : sxs[c1 + 1]) - leftE >= 43.95) {
								const rightE =
									c1 === subCols - 1
										? colR(r.right - 0.25)
											? r.right
											: refinePredicate(sxs[subCols - 1], r.right - 0.25, colR, false)
										: refinePredicate(sxs[c1], sxs[c1 + 1], colR, false);
								if (rightE - leftE >= 43.95) {
									const topE =
										r0 === 0
											? rowT(r.top + 0.25)
												? r.top
												: refinePredicate(r.top + 0.25, sys[0], rowT, true)
											: refinePredicate(sys[r0 - 1], sys[r0], rowT, true);
									if ((r1 === subRows - 1 ? r.bottom : sys[r1 + 1]) - topE >= 43.95) {
										const bottomE =
											r1 === subRows - 1
												? rowB(r.bottom - 0.25)
													? r.bottom
													: refinePredicate(sys[subRows - 1], r.bottom - 0.25, rowB, false)
												: refinePredicate(sys[r1], sys[r1 + 1], rowB, false);
										if (bottomE - topE >= 43.95) {
											sr = {
												left: leftE,
												top: topE,
												right: rightE,
												bottom: bottomE,
												w: rightE - leftE,
												h: bottomE - topE,
											};
										}
									}
								}
							}
							if (sr && blockedPtsHas44x44Gap(sr.left, sr.top, sr.right, sr.bottom)) {
								const sk = `${Math.round(sr.left * 4)},${Math.round(sr.top * 4)},${Math.round(sr.right * 4)},${Math.round(sr.bottom * 4)}`;
								if (!seenSub.has(sk)) {
									seenSub.add(sk);
									if (sr.w <= 120 && sr.h <= 120) {
										if (checkSubRectHairline(sr.left, sr.top, sr.right, sr.bottom)) return true;
									} else {
										subLarge.push(sr);
									}
								}
							}
							const shrunk =
								!sr ||
								sr.left > sc.rawL + 0.5 ||
								sr.right < sc.rawR - 0.5 ||
								sr.top > sc.rawT + 0.5 ||
								sr.bottom < sc.rawB - 0.5;
							if (
								shrunk &&
								Math.min(sc.rawR - sc.rawL, sc.rawB - sc.rawT) >= 43.95 &&
								blockedPtsHas44x44Gap(sc.rawL, sc.rawT, sc.rawR, sc.rawB)
							) {
								const scRaw = {
									left: sc.rawL,
									top: sc.rawT,
									right: sc.rawR,
									bottom: sc.rawB,
									w: sc.rawR - sc.rawL,
									h: sc.rawB - sc.rawT,
								};
								const rsk = `${Math.round(scRaw.left * 4)},${Math.round(scRaw.top * 4)},${Math.round(scRaw.right * 4)},${Math.round(scRaw.bottom * 4)}`;
								if (!seenSub.has(rsk)) {
									seenSub.add(rsk);
									if (scRaw.w <= 120 && scRaw.h <= 120) {
										if (checkSubRectHairline(scRaw.left, scRaw.top, scRaw.right, scRaw.bottom)) return true;
									} else {
										subLarge.push(scRaw);
									}
								}
							}
						}
						const pruneContained = (arr) => {
							if (arr.length <= 1) return arr;
							const desc = [...arr].sort((a, b) => b.w * b.h - a.w * a.h);
							const kept = [];
							for (let i = 0; i < desc.length; i++) {
								const cand = desc[i];
								let covered = false;
								for (let j = 0; j < kept.length; j++) {
									const k = kept[j];
									if (
										cand.left >= k.left - 0.01 &&
										cand.top >= k.top - 0.01 &&
										cand.right <= k.right + 0.01 &&
										cand.bottom <= k.bottom + 0.01
									) {
										covered = true;
										break;
									}
								}
								if (!covered) kept.push(cand);
							}
							kept.reverse();
							return kept;
						};
						for (const sr of pruneContained(subLarge)) {
							if (performance.now() > targetDeadline) return false;
							if (rectPassesHairlineCheck(sr)) return true;
						}
						return false;
					};

					const runHintGapsFastPath = () => {
						const ovInfo = getElOverlaps();
						const { items } = ovInfo;
						if (items.length < 200) return false;
						const hintPts = [];
						for (let i = 0; i < items.length; i++) {
							if (items[i].tier > 2) continue;
							const { oL, oR, oT, oB, oW, oH } = items[i];
							if (oW <= 43.9 && oH <= 43.9) {
								hintPts.push({ x: (oL + oR) / 2, y: (oT + oB) / 2 });
							} else {
								const nx = Math.max(2, Math.ceil(oW / 36));
								const ny = Math.max(2, Math.ceil(oH / 36));
								for (let ky = 0; ky < ny; ky++) {
									const py = oT + ((ky + 0.5) / ny) * oH;
									for (let kx = 0; kx < nx; kx++) {
										hintPts.push({ x: oL + ((kx + 0.5) / nx) * oW, y: py });
									}
								}
							}
						}
						const hintGaps = extractBlockedPtsGaps(visLeft, visTop, visRight, visBottom, hintPts);
						for (const g of hintGaps) {
							if (performance.now() > targetDeadline) return false;
							const tryL = g.right - Math.ceil(g.left) >= 43.95 ? Math.ceil(g.left) : g.left;
							const tryT = g.bottom - Math.ceil(g.top) >= 43.95 ? Math.ceil(g.top) : g.top;
							const prR = Math.min(g.right, tryL + 46);
							const prB = Math.min(g.bottom, tryT + 46);
							if (
								checkSubRectHairline(tryL, tryT, prR, prB) ||
								checkSubRectHairline(
									g.left,
									g.top,
									Math.min(g.right, g.left + 46),
									Math.min(g.bottom, g.top + 46),
								) ||
								(g.w > 46 || g.h > 46 ? rectPassesHairlineCheck(g) : false)
							) {
								return true;
							}
						}
						return false;
					};

					const preOvInfo = getElOverlaps();
					if (totalTargets === 1 && preOvInfo.items.length >= 800 && isNonZoomed) {
						targetDeadline = Math.min(tTargetStart + 4200, tEvalStart + 3600);
					}
					let preFoundValidRect = false;
					let preEarlyOccluded = false;
					if ((visibleWidth > 120 || visibleHeight > 120) && preOvInfo.items.length >= 200) {
						if (runHintGapsFastPath()) {
							preFoundValidRect = true;
						} else {
							collectDomBlockedPts();
							if (
								!preOvInfo.hasShadowDom &&
								!preOvInfo.hasUnboundedPseudo &&
								!blockedPtsHasMinGap(visLeft, visTop, visRight, visBottom, minEarlyGap)
							) {
								preEarlyOccluded = true;
							}
						}
					}
					if (preFoundValidRect) {
						continue;
					}
					if (preEarlyOccluded) {
						out.push({
							selector: sel,
							index,
							reason: "occluded",
							width: Math.min(visibleWidth, 43),
							height: Math.min(visibleHeight, 43),
							occludedBy: blockerTag || "unknown",
						});
						continue;
					}

					let gridTimedOut = false;
					const grid = [];
					for (let j = 0; j < rows; j++) {
						if (performance.now() > targetDeadline) {
							gridTimedOut = true;
							break;
						}
						grid.push(xs.map((x) => hitsAt(x, ys[j])));
					}
					if (gridTimedOut) {
						out.push({
							selector: sel,
							index,
							reason: "occluded",
							width: Math.min(visibleWidth, 43),
							height: Math.min(visibleHeight, 43),
							occludedBy: blockerTag || "unknown",
						});
						continue;
					}

					// O(rows * cols) largest-rectangle-in-histogram
					const heights = new Array(cols).fill(0);
					let bestSquareRaw = null;
					let bestAreaRaw = null;
					const candMap = new Map();
					const considerCand = (c0, r0, c1, r1) => {
						const rawL = c0 === 0 ? visLeft : xs[c0 - 1];
						const rawR = c1 === cols - 1 ? visRight : xs[c1 + 1];
						const rawT = r0 === 0 ? visTop : ys[r0 - 1];
						const rawB = r1 === rows - 1 ? visBottom : ys[r1 + 1];
						const rawW = rawR - rawL;
						const rawH = rawB - rawT;
						const rawMin = Math.min(rawW, rawH);
						const rawArea = rawW * rawH;
						if (
							!bestSquareRaw ||
							rawMin > bestSquareRaw.rawMin ||
							(rawMin === bestSquareRaw.rawMin && rawArea > bestSquareRaw.rawArea)
						) {
							bestSquareRaw = { c0, r0, c1, r1, rawMin, rawArea };
						}
						if (!bestAreaRaw || rawArea > bestAreaRaw.rawArea) {
							bestAreaRaw = { c0, r0, c1, r1, rawMin, rawArea };
						}
						if (rawMin >= 43.95) {
							const key = `${c0},${r0},${c1},${r1}`;
							if (!candMap.has(key)) {
								const innerW = xs[c1] - xs[c0];
								const innerH = ys[r1] - ys[r0];
								candMap.set(key, {
									c0,
									r0,
									c1,
									r1,
									rawL,
									rawR,
									rawT,
									rawB,
									rawMin,
									rawArea,
									innerMin: Math.min(innerW, innerH),
								});
							}
						}
					};

					for (let j = 0; j < rows; j++) {
						for (let i = 0; i < cols; i++) {
							heights[i] = grid[j][i] ? heights[i] + 1 : 0;
						}
						const stack = [];
						for (let i = 0; i <= cols; i++) {
							const curH = i === cols ? 0 : heights[i];
							let startCol = i;
							while (stack.length > 0 && stack[stack.length - 1].h > curH) {
								const top = stack.pop();
								startCol = top.start;
								if (top.h > 0) {
									considerCand(top.start, j - top.h + 1, i - 1, j);
								}
							}
							if (stack.length === 0 || stack[stack.length - 1].h < curH) {
								stack.push({ start: startCol, h: curH });
							}
						}
					}

					const refineCandRect = (cand) => {
						if (!cand) return null;
						const { c0, r0, c1, r1 } = cand;
						const yMid = (ys[r0] + ys[r1]) / 2;
						const xMid = (xs[c0] + xs[c1]) / 2;
						const ySamplesLeft = r0 === r1 || hitsAt(xs[c0], yMid) ? [ys[r0], yMid, ys[r1]] : [ys[r0], ys[r1]];
						const ySamplesRight = r0 === r1 || hitsAt(xs[c1], yMid) ? [ys[r0], yMid, ys[r1]] : [ys[r0], ys[r1]];
						const xSamplesTop = c0 === c1 || hitsAt(xMid, ys[r0]) ? [xs[c0], xMid, xs[c1]] : [xs[c0], xs[c1]];
						const xSamplesBottom = c0 === c1 || hitsAt(xMid, ys[r1]) ? [xs[c0], xMid, xs[c1]] : [xs[c0], xs[c1]];
						const colOkLeft = (x) => ySamplesLeft.every((y) => hitsAt(x, y));
						const colOkRight = (x) => ySamplesRight.every((y) => hitsAt(x, y));
						const rowOkTop = (y) => xSamplesTop.every((x) => hitsAt(x, y));
						const rowOkBottom = (y) => xSamplesBottom.every((x) => hitsAt(x, y));

						const leftEdge =
							c0 === 0
								? colOkLeft(visLeft + 0.25)
									? visLeft
									: refinePredicate(visLeft + 0.25, xs[0], colOkLeft, true)
								: refinePredicate(xs[c0 - 1], xs[c0], colOkLeft, true);
						const maxPossibleRight = c1 === cols - 1 ? visRight : xs[c1 + 1];
						if (maxPossibleRight - leftEdge < 43.95) return null;
						const rightEdge =
							c1 === cols - 1
								? colOkRight(visRight - 0.25)
									? visRight
									: refinePredicate(xs[cols - 1], visRight - 0.25, colOkRight, false)
								: refinePredicate(xs[c1], xs[c1 + 1], colOkRight, false);
						if (rightEdge - leftEdge < 43.95) return null;
						const topEdge =
							r0 === 0
								? rowOkTop(visTop + 0.25)
									? visTop
									: refinePredicate(visTop + 0.25, ys[0], rowOkTop, true)
								: refinePredicate(ys[r0 - 1], ys[r0], rowOkTop, true);
						const maxPossibleBottom = r1 === rows - 1 ? visBottom : ys[r1 + 1];
						if (maxPossibleBottom - topEdge < 43.95) return null;
						const bottomEdge =
							r1 === rows - 1
								? rowOkBottom(visBottom - 0.25)
									? visBottom
									: refinePredicate(ys[rows - 1], visBottom - 0.25, rowOkBottom, false)
								: refinePredicate(ys[r1], ys[r1 + 1], rowOkBottom, false);

						return {
							left: leftEdge,
							top: topEdge,
							right: rightEdge,
							bottom: bottomEdge,
							w: Math.max(0, rightEdge - leftEdge),
							h: Math.max(0, bottomEdge - topEdge),
						};
					};

					let foundValidRect = false;
					if (visibleWidth > 120 || visibleHeight > 120 || candMap.size > 4) {
						collectDomBlockedPts();
					}

					const refinedSquare = performance.now() <= targetDeadline ? refineCandRect(bestSquareRaw) : null;
					const refinedArea =
						performance.now() > targetDeadline
							? null
							: bestAreaRaw &&
								  bestSquareRaw &&
								  bestAreaRaw.c0 === bestSquareRaw.c0 &&
								  bestAreaRaw.r0 === bestSquareRaw.r0 &&
								  bestAreaRaw.c1 === bestSquareRaw.c1 &&
								  bestAreaRaw.r1 === bestSquareRaw.r1
								? refinedSquare
								: refineCandRect(bestAreaRaw);

					if (!foundValidRect) {
						foundValidRect =
							refinedSquare &&
							refinedSquare.w <= 120 &&
							refinedSquare.h <= 120 &&
							rectPassesHairlineCheck(refinedSquare);
					}
					if (
						!foundValidRect &&
						refinedArea &&
						refinedArea !== refinedSquare &&
						refinedArea.w <= 120 &&
						refinedArea.h <= 120
					) {
						foundValidRect = rectPassesHairlineCheck(refinedArea);
					}
					if (!foundValidRect && candMap.size > 0) {
						const triedCands = new Set();
						const markRectKey = (r) =>
							`${Math.round(r.left * 4)},${Math.round(r.top * 4)},${Math.round(r.right * 4)},${Math.round(r.bottom * 4)}`;
						const seenRefinedRects = new Set();
						if (refinedSquare && refinedSquare.w <= 120 && refinedSquare.h <= 120) {
							seenRefinedRects.add(markRectKey(refinedSquare));
						}
						if (refinedArea && refinedArea.w <= 120 && refinedArea.h <= 120) {
							seenRefinedRects.add(markRectKey(refinedArea));
						}

						const orderedCands = Array.from(candMap.values()).sort(
							(a, b) => a.rawArea - b.rawArea || a.rawMin - b.rawMin,
						);
						const largeDeferred = [];
						for (const cand of orderedCands) {
							if (performance.now() > targetDeadline) break;
							const cKey = `${cand.c0},${cand.r0},${cand.c1},${cand.r1}`;
							if (triedCands.has(cKey)) continue;
							if (!blockedPtsHas44x44Gap(cand.rawL, cand.rawT, cand.rawR, cand.rawB)) continue;
							const refined = refineCandRect(cand);
							if (refined && refined.w >= 43.95 && refined.h >= 43.95) {
								const rKey = markRectKey(refined);
								if (!seenRefinedRects.has(rKey)) {
									seenRefinedRects.add(rKey);
									if (refined.w <= 120 && refined.h <= 120) {
										if (rectPassesHairlineCheck(refined)) {
											foundValidRect = true;
											break;
										}
									} else {
										largeDeferred.push(refined);
									}
								}
							}
							const shrunk =
								!refined ||
								refined.w < 43.95 ||
								refined.h < 43.95 ||
								refined.left > cand.rawL + 0.5 ||
								refined.right < cand.rawR - 0.5 ||
								refined.top > cand.rawT + 0.5 ||
								refined.bottom < cand.rawB - 0.5;
							if (shrunk && cand.rawMin >= 43.95 && blockedPtsHas44x44Gap(cand.rawL, cand.rawT, cand.rawR, cand.rawB)) {
								const rawRect = {
									left: cand.rawL,
									top: cand.rawT,
									right: cand.rawR,
									bottom: cand.rawB,
									w: cand.rawR - cand.rawL,
									h: cand.rawB - cand.rawT,
								};
								const rawKey = markRectKey(rawRect);
								if (!seenRefinedRects.has(rawKey)) {
									seenRefinedRects.add(rawKey);
									if (rawRect.w <= 120 && rawRect.h <= 120) {
										if (rectPassesHairlineCheck(rawRect)) {
											foundValidRect = true;
											break;
										}
									} else {
										largeDeferred.push(rawRect);
									}
								}
							}
						}
						if (!foundValidRect) {
							const descLarge = [...largeDeferred].sort((a, b) => b.w * b.h - a.w * a.h);
							const maxLarge = [];
							for (let i = 0; i < descLarge.length; i++) {
								const cand = descLarge[i];
								let covered = false;
								for (let j = 0; j < maxLarge.length; j++) {
									const k = maxLarge[j];
									if (
										cand.left >= k.left - 0.01 &&
										cand.top >= k.top - 0.01 &&
										cand.right <= k.right + 0.01 &&
										cand.bottom <= k.bottom + 0.01
									) {
										covered = true;
										break;
									}
								}
								if (!covered) maxLarge.push(cand);
							}
							maxLarge.reverse();
							for (const refined of maxLarge) {
								if (performance.now() > targetDeadline) break;
								if (checkLargeRefinedRect(refined)) {
									foundValidRect = true;
									break;
								}
							}
						}
					}

					if (foundValidRect) {
						continue;
					}

					// Compute row/col spans (and 1px center cross lines) only when needed for rounded-geometry check or fallback diagnostics
					let bestRowSpan = 0;
					let bestColSpan = 0;
					const rowWideRuns = [];
					const colWideRuns = [];
					if (
						performance.now() <= targetDeadline &&
						(clip.hasRoundedClip || !refinedSquare || refinedSquare.w === 0 || refinedSquare.h === 0)
					) {
						for (let j = 0; j < rows; j++) {
							if (performance.now() > targetDeadline) break;
							let i = 0;
							while (i < cols) {
								if (performance.now() > targetDeadline) break;
								if (!grid[j][i]) {
									i++;
									continue;
								}
								const start = i;
								while (i < cols && grid[j][i]) i++;
								const end = i - 1;
								const leftEdge =
									start === 0
										? hitsAt(visLeft + 0.25, ys[j])
											? visLeft
											: refinePredicate(visLeft + 0.25, xs[0], (x) => hitsAt(x, ys[j]), true)
										: refinePredicate(xs[start - 1], xs[start], (x) => hitsAt(x, ys[j]), true);
								const rightEdge =
									end === cols - 1
										? hitsAt(visRight - 0.25, ys[j])
											? visRight
											: refinePredicate(xs[cols - 1], visRight - 0.25, (x) => hitsAt(x, ys[j]), false)
										: refinePredicate(xs[end], xs[end + 1], (x) => hitsAt(x, ys[j]), false);
								const span = rightEdge - leftEdge;
								bestRowSpan = Math.max(bestRowSpan, span);
								if (clip.hasRoundedClip && span >= 43.95) {
									rowWideRuns.push({ cx: (leftEdge + rightEdge) / 2, cy: ys[j], span, leftEdge, rightEdge });
								}
							}
						}

						for (let i = 0; i < cols; i++) {
							if (performance.now() > targetDeadline) break;
							let j = 0;
							while (j < rows) {
								if (performance.now() > targetDeadline) break;
								if (!grid[j][i]) {
									j++;
									continue;
								}
								const start = j;
								while (j < rows && grid[j][i]) j++;
								const end = j - 1;
								const topEdge =
									start === 0
										? hitsAt(xs[i], visTop + 0.25)
											? visTop
											: refinePredicate(visTop + 0.25, ys[0], (y) => hitsAt(xs[i], y), true)
										: refinePredicate(ys[start - 1], ys[start], (y) => hitsAt(xs[i], y), true);
								const bottomEdge =
									end === rows - 1
										? hitsAt(xs[i], visBottom - 0.25)
											? visBottom
											: refinePredicate(ys[rows - 1], visBottom - 0.25, (y) => hitsAt(xs[i], y), false)
										: refinePredicate(ys[end], ys[end + 1], (y) => hitsAt(xs[i], y), false);
								const span = bottomEdge - topEdge;
								bestColSpan = Math.max(bestColSpan, span);
								if (clip.hasRoundedClip && span >= 43.95) {
									colWideRuns.push({ cx: xs[i], cy: (topEdge + bottomEdge) / 2, span, topEdge, bottomEdge });
								}
							}
						}
					}

					const midX = (visLeft + visRight) / 2;
					const midY = (visTop + visBottom) / 2;
					const centerHRun =
						clip.hasRoundedClip && performance.now() <= targetDeadline
							? maxContigLineSpan(visLeft, visRight, (x) => hitsAt(x, midY))
							: null;
					const centerVRun =
						clip.hasRoundedClip && performance.now() <= targetDeadline
							? maxContigLineSpan(visTop, visBottom, (y) => hitsAt(midX, y))
							: null;
					if (centerHRun) bestRowSpan = Math.max(bestRowSpan, centerHRun.maxSpan);
					if (centerVRun) bestColSpan = Math.max(bestColSpan, centerVRun.maxSpan);

					if (clip.hasRoundedClip && performance.now() <= targetDeadline && bestRowSpan >= 43.95 && bestColSpan >= 43.95) {
						const halfCore = 15.45; // 30.9 / 2 (inscribed square of 44px circle is 31.11px)
						const circR = 21.6;
						const checkRoundedCoreAt = (cx, cy, hHint = null, vHint = null) => {
							if (performance.now() > targetDeadline) return false;
							if (!hitsAt(cx, cy)) return false;
							const hRun = hHint || maxContigLineSpan(visLeft, visRight, (x) => hitsAt(x, cy));
							if (hRun.maxSpan < 43.95) return false;
							const vRun = vHint || maxContigLineSpan(visTop, visBottom, (y) => hitsAt(cx, y));
							if (vRun.maxSpan < 43.95) return false;

							const cIx0 = Math.ceil(cx - halfCore);
							const cIx1 = Math.floor(cx + halfCore);
							const cIy0 = Math.ceil(cy - halfCore);
							const cIy1 = Math.floor(cy + halfCore);
							if (cIx1 - cIx0 + 1 < 28 || cIy1 - cIy0 + 1 < 28) return false;
							for (let iy = cIy0; iy <= cIy1; iy++) {
								if ((iy & 3) === 0 && performance.now() > targetDeadline) return false;
								const py = iy + 0.5;
								for (let ix = cIx0; ix <= cIx1; ix++) {
									if (!hitsAt(ix + 0.5, py)) return false;
								}
							}

							const rIx0 = Math.ceil(cx - circR);
							const rIx1 = Math.floor(cx + circR);
							const rIy0 = Math.ceil(cy - circR);
							const rIy1 = Math.floor(cy + circR);
							let circTotal = 0;
							for (let iy = rIy0; iy <= rIy1; iy++) {
								if ((iy & 3) === 0 && performance.now() > targetDeadline) return false;
								const dy = iy - cy;
								const py = iy + 0.5;
								for (let ix = rIx0; ix <= rIx1; ix++) {
									const dx = ix - cx;
									if (dx * dx + dy * dy <= circR * circR) {
										circTotal++;
										if (!hitsAt(ix + 0.5, py)) return false;
									}
								}
							}
							return circTotal > 0;
						};

						let roundedPass = false;
						const seenCenters = new Set();
						const tryCenter = (cx, cy, hHint = null, vHint = null) => {
							if (roundedPass || !Number.isFinite(cx) || !Number.isFinite(cy)) return;
							const key = `${Math.round(cx)},${Math.round(cy)}`;
							if (seenCenters.has(key)) return;
							seenCenters.add(key);
							if (checkRoundedCoreAt(cx, cy, hHint, vHint)) {
								roundedPass = true;
							}
						};

						// 1. Try bounding-box center and centered cross midpoint first
						if (hitsAt(midX, midY) && centerHRun.maxSpan >= 43.95 && centerVRun.maxSpan >= 43.95) {
							const coreCx = (centerHRun.bestStart + centerHRun.bestEnd) / 2;
							const coreCy = (centerVRun.bestStart + centerVRun.bestEnd) / 2;
							tryCenter(
								coreCx,
								coreCy,
								Math.abs(coreCy - midY) < 0.25 ? centerHRun : null,
								Math.abs(coreCx - midX) < 0.25 ? centerVRun : null,
							);
							tryCenter(midX, midY, centerHRun, centerVRun);
						}

						// 2. Off-center fallback: locate candidate centers from widest unoccluded horizontal & vertical chords
						//    plus chord-wall inset candidates (bestStart + 22 / bestEnd - 22) for quadrant-occluded circles.
						if (!roundedPass) {
							const offCenters = [];
							const addChordCandidates = (xCand, yRun, hHint = null) => {
								if (!yRun || yRun.maxSpan < 43.95) return;
								const cyMid = (yRun.bestStart + yRun.bestEnd) / 2;
								const score0 = hHint ? Math.min(hHint.maxSpan, yRun.maxSpan) : yRun.maxSpan;
								const yOpts = [cyMid, yRun.bestStart + 22, yRun.bestEnd - 22];
								for (const cyOpt of yOpts) {
									offCenters.push({ cx: xCand, cy: cyOpt, score: score0, hHint, vHint: cyOpt === cyMid ? yRun : null });
								}
								const hRun = hHint || maxContigLineSpan(visLeft, visRight, (x) => hitsAt(x, cyMid));
								if (hRun.maxSpan >= 43.95) {
									const cxMid = (hRun.bestStart + hRun.bestEnd) / 2;
									const score1 = Math.min(hRun.maxSpan, yRun.maxSpan);
									const xOpts = [cxMid, hRun.bestStart + 22, hRun.bestEnd - 22];
									for (const cxOpt of xOpts) {
										for (const cyOpt of yOpts) {
											offCenters.push({
												cx: cxOpt,
												cy: cyOpt,
												score: score1,
												hHint: cyOpt === cyMid ? hRun : null,
												vHint: cxOpt === cxMid ? yRun : null,
											});
										}
									}
								}
							};
							for (const rr of rowWideRuns) {
								if (performance.now() > targetDeadline) break;
								const vRun = maxContigLineSpan(visTop, visBottom, (y) => hitsAt(rr.cx, y));
								addChordCandidates(rr.cx, vRun);
							}
							const topRowRuns = [...rowWideRuns].sort((a, b) => b.span - a.span).slice(0, 3);
							for (const rr of topRowRuns) {
								if (performance.now() > targetDeadline) break;
								for (const xInset of [rr.leftEdge + 22, rr.rightEdge - 22]) {
									if (xInset > visLeft && xInset < visRight) {
										const vRun = maxContigLineSpan(visTop, visBottom, (y) => hitsAt(xInset, y));
										addChordCandidates(xInset, vRun);
									}
								}
							}
							for (const cr of colWideRuns) {
								if (performance.now() > targetDeadline) break;
								const hRun = maxContigLineSpan(visLeft, visRight, (x) => hitsAt(x, cr.cy));
								if (hRun.maxSpan >= 43.95) {
									const cxMid = (hRun.bestStart + hRun.bestEnd) / 2;
									for (const cxOpt of [cxMid, hRun.bestStart + 22, hRun.bestEnd - 22]) {
										offCenters.push({
											cx: cxOpt,
											cy: cr.cy,
											score: Math.min(hRun.maxSpan, cr.span),
											hHint: hRun,
											vHint: null,
										});
										const vRun = maxContigLineSpan(visTop, visBottom, (y) => hitsAt(cxOpt, y));
										addChordCandidates(cxOpt, vRun, hRun);
									}
								}
							}
							const topColRuns = [...colWideRuns].sort((a, b) => b.span - a.span).slice(0, 3);
							for (const cr of topColRuns) {
								if (performance.now() > targetDeadline) break;
								for (const yInset of [cr.topEdge + 22, cr.bottomEdge - 22]) {
									if (yInset > visTop && yInset < visBottom) {
										const hRun = maxContigLineSpan(visLeft, visRight, (x) => hitsAt(x, yInset));
										if (hRun.maxSpan >= 43.95) {
											const cxMid = (hRun.bestStart + hRun.bestEnd) / 2;
											for (const cxOpt of [cxMid, hRun.bestStart + 22, hRun.bestEnd - 22]) {
												offCenters.push({
													cx: cxOpt,
													cy: yInset,
													score: Math.min(hRun.maxSpan, cr.span),
													hHint: hRun,
													vHint: null,
												});
											}
										}
									}
								}
							}
							if (refinedSquare && refinedSquare.w >= 30.5 && refinedSquare.h >= 30.5) {
								offCenters.push({
									cx: (refinedSquare.left + refinedSquare.right) / 2,
									cy: (refinedSquare.top + refinedSquare.bottom) / 2,
									score: Math.min(refinedSquare.w, refinedSquare.h),
									hHint: null,
									vHint: null,
								});
							}
							offCenters.sort((a, b) => b.score - a.score);
							for (const cand of offCenters) {
								if (seenCenters.size >= 24 || performance.now() > targetDeadline) break;
								tryCenter(cand.cx, cand.cy, cand.hHint, cand.vHint);
								if (roundedPass) break;
							}
						}

						if (roundedPass) {
							continue;
						}
					}

					const diagW = refinedSquare ? Math.max(refinedSquare.w, refinedArea ? refinedArea.w : 0) : bestRowSpan;
					const diagH = refinedSquare ? Math.max(refinedSquare.h, refinedArea ? refinedArea.h : 0) : bestColSpan;
					out.push({
						selector: sel,
						index,
						reason: "occluded",
						width: Math.min(visibleWidth, diagW || bestRowSpan),
						height: Math.min(visibleHeight, diagH || bestColSpan),
						occludedBy: blockerTag || "unknown",
					});
				}
			}
			return out;
		},
		{ checkMode: mode, sels: selectors },
	);
}

export async function assertPopoversInViewport(page) {
	const clipped = await runDomGeometryCheck(page, { mode: "popovers", selectors: POPOVER_SELECTORS });
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
	const failures = await runDomGeometryCheck(page, { mode: "touch", selectors });
	expect(failures).toEqual([]);
}
