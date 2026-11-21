import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { closeDrawingPad, openDrawingPad, toggleKarorasterGrid, toggleQuestionContext } from "../helpers/drawing-pad.mjs";
import { resolveRepoDir } from "../harness/server-controller.mjs";
import {
	assertNoHorizontalOverflow,
	assertPopoversInViewport,
	assertTouchTargets,
	bootStack,
	composerInput,
	createChatSession,
	loginApi,
	loginBrowser,
	questionInput,
	VIEWPORT_MATRIX,
	viewportContextOptions,
} from "../helpers/e2e-session.mjs";
import {
	analyzePngPixels,
	assertPngContrast,
	buildSample3PagePdf,
	createSolidPng,
	createVectorDiagramPng,
} from "../helpers/test-assets.mjs";

async function dispatchClipboardPaste(locator, { pngBuffer, text } = {}) {
	const b64 = pngBuffer ? pngBuffer.toString("base64") : null;
	await locator.evaluate(
		(el, { base64, plainText }) => {
			el.focus();
			const dt = new DataTransfer();
			if (base64) {
				const bin = atob(base64);
				const bytes = new Uint8Array(bin.length);
				for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
				const file = new File([bytes], "clipboard-screenshot.png", { type: "image/png" });
				dt.items.add(file);
			}
			if (plainText !== undefined) {
				dt.setData("text/plain", plainText);
			}
			const evt = new ClipboardEvent("paste", {
				clipboardData: dt,
				bubbles: true,
				cancelable: true,
			});
			el.dispatchEvent(evt);
		},
		{ base64: b64, plainText: text },
	);
}

async function drawCanvasStroke(page, canvasLocator, { pointerType = "pen", points }) {
	const box = await canvasLocator.boundingBox();
	expect(box).toBeTruthy();
	await canvasLocator.evaluate(
		(canvas, { pType, pts, rect }) => {
			const abs = pts.map(([rx, ry]) => ({
				clientX: rect.x + rx * rect.width,
				clientY: rect.y + ry * rect.height,
			}));
			const makeEvt = (type, pt, buttons) =>
				new PointerEvent(type, {
					pointerId: 1,
					pointerType: pType,
					isPrimary: true,
					clientX: pt.clientX,
					clientY: pt.clientY,
					pressure: type === "pointerup" ? 0 : 0.7,
					buttons,
					bubbles: true,
					cancelable: true,
				});
			canvas.dispatchEvent(makeEvt("pointerdown", abs[0], 1));
			for (let i = 1; i < abs.length; i++) {
				canvas.dispatchEvent(makeEvt("pointermove", abs[i], 1));
			}
			canvas.dispatchEvent(makeEvt("pointerup", abs[abs.length - 1], 0));
		},
		{ pType: pointerType, pts: points, rect: box },
	);
}

test.describe("Tier 1 — F9: Chat & Question Attachments (Images, PDFs, Ctrl+V)", () => {
	test("T1-F9-01: Image upload in normal chat delivers ImageContent to mock model and renders in transcript", async ({ browser }) => {
		const stack = await bootStack({ mockOptions: { chunkDelayMs: 5 } });
		const context = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-DESK-REF"]));
		const page = await context.newPage();
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			const chat = await createChatSession(stack.baseUrl, cookie, { title: "Image Chat Upload" });
			const png = createVectorDiagramPng(64, 48);
			const shaPrefix = createHash("sha256").update(png).digest("hex").slice(0, 12);

			await loginBrowser(page, stack.baseUrl);
			await page.goto(`${stack.baseUrl}/chat/${chat.id}`);

			await page.getByTestId("attach-files-input").setInputFiles({
				name: "vector-upload.png",
				mimeType: "image/png",
				buffer: png,
			});
			await expect(page.getByText(/vector-upload\.png/i)).toBeVisible();

			const input = composerInput(page);
			await input.fill("[ECHO_VISION] inspect uploaded diagram");
			await page.getByRole("button", { name: "Send" }).click();

			await expect(page.getByText(new RegExp(`sha256=${shaPrefix}`))).toBeVisible({ timeout: 15_000 });
			const ledger = await stack.mock.getRequests();
			expect(ledger.requests[ledger.requests.length - 1].images.length).toBe(1);
		} finally {
			await context.close();
			await stack.cleanup();
		}
	});

	test("T1-F9-02: PDF upload in normal chat resolves page content server-side even with fileAccess restricted", async ({ browser }) => {
		const stack = await bootStack({ mockOptions: { chunkDelayMs: 5 } });
		const context = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-DESK-REF"]));
		const page = await context.newPage();
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			await fetch(`${stack.baseUrl}/api/settings/agent`, {
				method: "PUT",
				headers: { "Content-Type": "application/json", Cookie: cookie },
				body: JSON.stringify({ fileAccess: { restricted: true, folders: [] } }),
			});

			const chat = await createChatSession(stack.baseUrl, cookie, { title: "PDF Upload" });
			const pdf = buildSample3PagePdf();

			await loginBrowser(page, stack.baseUrl);
			await page.goto(`${stack.baseUrl}/chat/${chat.id}`);

			await page.getByTestId("attach-files-input").setInputFiles({
				name: "sample-3page.pdf",
				mimeType: "application/pdf",
				buffer: pdf,
			});
			await expect(page.getByText(/sample-3page\.pdf/i)).toBeVisible();

			const input = composerInput(page);
			await input.fill("Summarize page 2 trajectory equation");
			await page.getByRole("button", { name: "Send" }).click();

			await expect(page.getByText(/Synthetic tutor response/i)).toBeVisible({ timeout: 15_000 });
			const ledger = await stack.mock.getRequests();
			const rawReq = JSON.stringify(ledger.requests[ledger.requests.length - 1]);
			expect(rawReq).toContain("Projectile trajectory equation");
		} finally {
			await context.close();
			await stack.cleanup();
		}
	});

	test("T1-F9-03: Ctrl+V screenshot paste in Free-Response & MC PathInput preserves text paste", async ({ browser }) => {
		const stack = await bootStack({ mockOptions: { chunkDelayMs: 5 } });
		const context = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-DESK-REF"]));
		const page = await context.newPage();
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			const freeChat = await createChatSession(stack.baseUrl, cookie, { title: "Paste Free" });
			const mcChat = await createChatSession(stack.baseUrl, cookie, { title: "Paste MC" });
			const png = createVectorDiagramPng(48, 36);

			await loginBrowser(page, stack.baseUrl);

			// Free-response paste
			await page.goto(`${stack.baseUrl}/chat/${freeChat.id}`);
			await composerInput(page).fill("[TRIGGER_FREE]");
			await page.getByRole("button", { name: "Send" }).click();
			const freeInput = questionInput(page, "answer");
			await expect(freeInput).toBeVisible({ timeout: 15_000 });
			await dispatchClipboardPaste(freeInput, { pngBuffer: png });
			await expect(page.getByTestId("question-dock").locator("img")).toBeVisible();
			await dispatchClipboardPaste(freeInput, { text: "Pasted text justification" });
			await expect(freeInput).toContainText("Pasted text justification");

			// MC thinking paste
			await page.goto(`${stack.baseUrl}/chat/${mcChat.id}`);
			await composerInput(page).fill("[TRIGGER_MC]");
			await page.getByRole("button", { name: "Send" }).click();
			const mcInput = questionInput(page, "thinking");
			await expect(mcInput).toBeVisible({ timeout: 15_000 });
			await dispatchClipboardPaste(mcInput, { pngBuffer: png });
			await expect(page.getByTestId("question-dock").locator("img")).toBeVisible();
		} finally {
			await context.close();
			await stack.cleanup();
		}
	});

	test("T1-F9-04: Multiple-Choice answer with attached image + option + reasoning delivers all in same turn", async ({ browser }) => {
		const stack = await bootStack({ mockOptions: { chunkDelayMs: 5 } });
		const context = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-DESK-REF"]));
		const page = await context.newPage();
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			const chat = await createChatSession(stack.baseUrl, cookie, { title: "MC Image Answer" });
			const png = createVectorDiagramPng(48, 36);

			await loginBrowser(page, stack.baseUrl);
			await page.goto(`${stack.baseUrl}/chat/${chat.id}`);
			await composerInput(page).fill("[TRIGGER_MC]");
			await page.getByRole("button", { name: "Send" }).click();

			await expect(page.getByTestId("question-dock")).toBeVisible({ timeout: 15_000 });
			await page.getByRole("radio").nth(1).click();
			const mcInput = questionInput(page, "thinking");
			await mcInput.fill("[ECHO_VISION] Gravity accelerates downward even at apex");
			await dispatchClipboardPaste(mcInput, { pngBuffer: png });
			await expect(page.getByTestId("question-dock").locator("img")).toBeVisible();

			await stack.mock.clearRequests();
			await page.getByRole("button", { name: /Submit answer/i }).click();
			await expect(page.getByText(/VISION_ECHO count=1/)).toBeVisible({ timeout: 15_000 });

			const ledger = await stack.mock.getRequests();
			const turnReq = ledger.requests[ledger.requests.length - 1];
			expect(turnReq.images.length).toBe(1);
			expect(JSON.stringify(turnReq.messages)).toContain("Gravity accelerates downward");
		} finally {
			await context.close();
			await stack.cleanup();
		}
	});

	test("T1-F9-05: Free-Response image-only answer submission succeeds with blank text", async ({ browser }) => {
		const stack = await bootStack({ mockOptions: { chunkDelayMs: 5 } });
		const context = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-DESK-REF"]));
		const page = await context.newPage();
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			const chat = await createChatSession(stack.baseUrl, cookie, { title: "Image Only Free" });
			const png = createVectorDiagramPng(64, 48);

			await loginBrowser(page, stack.baseUrl);
			await page.goto(`${stack.baseUrl}/chat/${chat.id}`);
			await composerInput(page).fill("[TRIGGER_FREE]");
			await page.getByRole("button", { name: "Send" }).click();

			const freeInput = questionInput(page, "answer");
			await expect(freeInput).toBeVisible({ timeout: 15_000 });
			await dispatchClipboardPaste(freeInput, { pngBuffer: png });
			await expect(page.getByTestId("question-dock").locator("img")).toBeVisible();

			const submitBtn = page.getByRole("button", { name: /Submit answer/i });
			await expect(submitBtn).toBeEnabled();
			await stack.mock.clearRequests();
			await submitBtn.click();

			await expect(page.getByText(/received 1 image/i)).toBeVisible({ timeout: 15_000 });
			const ledger = await stack.mock.getRequests();
			expect(ledger.requests[ledger.requests.length - 1].images.length).toBe(1);
		} finally {
			await context.close();
			await stack.cleanup();
		}
	});

	test("T1-F9-06: Attachment preview removal before submit sends only remaining image", async ({ browser }) => {
		const stack = await bootStack({ mockOptions: { chunkDelayMs: 5 } });
		const context = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-DESK-REF"]));
		const page = await context.newPage();
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			const chat = await createChatSession(stack.baseUrl, cookie, { title: "Preview Removal" });
			const png1 = createSolidPng(32, 32, [220, 38, 38, 255]);
			const png2 = createSolidPng(40, 40, [29, 78, 216, 255]);
			const sha2Prefix = createHash("sha256").update(png2).digest("hex").slice(0, 12);

			await loginBrowser(page, stack.baseUrl);
			await page.goto(`${stack.baseUrl}/chat/${chat.id}`);
			await composerInput(page).fill("[TRIGGER_FREE]");
			await page.getByRole("button", { name: "Send" }).click();

			const freeInput = questionInput(page, "answer");
			await expect(freeInput).toBeVisible({ timeout: 15_000 });
			await dispatchClipboardPaste(freeInput, { pngBuffer: png1 });
			await dispatchClipboardPaste(freeInput, { pngBuffer: png2 });
			await expect(page.getByTestId("question-dock").locator("img")).toHaveCount(2);

			await page.getByTestId("question-dock").getByRole("button", { name: /remove|delete/i }).first().click();
			await expect(page.getByTestId("question-dock").locator("img")).toHaveCount(1);

			await freeInput.fill("[ECHO_VISION]");
			await stack.mock.clearRequests();
			await page.getByRole("button", { name: /Submit answer/i }).click();

			await expect(page.getByText(new RegExp(`count=1.*sha256=${sha2Prefix}`))).toBeVisible({ timeout: 15_000 });
		} finally {
			await context.close();
			await stack.cleanup();
		}
	});
});

test.describe("Tier 1 — F10: Overhauled Drawing Pad (Bild 3 -> Bild 1)", () => {
	test("T1-F10-01: Overhauled Drawing Pad full-canvas layout, Karoraster grid, and collapsible Question", async ({ browser }) => {
		const stack = await bootStack({ mockOptions: { chunkDelayMs: 5 } });
		const context = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-MD-PORT"]));
		const page = await context.newPage();
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			const chat = await createChatSession(stack.baseUrl, cookie, { title: "Drawing Layout" });

			await loginBrowser(page, stack.baseUrl);
			await page.goto(`${stack.baseUrl}/chat/${chat.id}`);
			await composerInput(page).fill("[TRIGGER_FREE]");
			await page.getByRole("button", { name: "Send" }).click();
			await expect(page.getByTestId("question-dock")).toBeVisible({ timeout: 15_000 });

			await openDrawingPad(page);
			const canvas = page.locator("canvas.drawing-pad-ink");
			await expect(canvas).toBeVisible();
			const box = await canvas.boundingBox();
			expect(box.width).toBeGreaterThan(700);
			expect(box.height).toBeGreaterThan(600);

			// Toggle Karoraster grid & Question context bar
			await toggleKarorasterGrid(page);
			await toggleQuestionContext(page);
			await expect(page.locator(".drawing-pad-question-drawer").getByText(/horizontal and vertical components/i)).toBeVisible();
		} finally {
			await context.close();
			await stack.cleanup();
		}
	});

	test("T1-F10-02: Pen, Eraser, Undo, Redo, Colors, and Stroke Widths", async ({ browser }) => {
		const stack = await bootStack();
		const context = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-MD-PORT"]));
		const page = await context.newPage();
		try {
			await loginBrowser(page, stack.baseUrl);
			await page.goto(`${stack.baseUrl}/chat/chat_synth_teach_01`);
			await openDrawingPad(page);
			const canvas = page.locator("canvas.drawing-pad-ink");
			await expect(canvas).toBeVisible();
			const beforeDraw = await canvas.evaluate((c) => c.toDataURL("image/png"));

			await drawCanvasStroke(page, canvas, {
				pointerType: "pen",
				points: [[0.2, 0.3], [0.5, 0.3], [0.8, 0.3]],
			});
			const afterOne = await canvas.evaluate((c) => c.toDataURL("image/png"));
			expect(afterOne).not.toBe(beforeDraw);

			const colorBtn = page.getByRole("button", { name: "Blue ink", exact: true });
			await expect(colorBtn).toBeVisible();
			await colorBtn.click();

			const widthSlider = page.getByRole("slider", { name: /width|size|thickness|stroke/i }).first();
			const widthBtn = page.getByRole("button", { name: /thick|large|medium|width|size|\d+\s*px/i }).last();
			if (await widthSlider.isVisible().catch(() => false)) {
				await widthSlider.fill("8");
			} else {
				await expect(widthBtn).toBeVisible();
				await widthBtn.click();
			}

			await drawCanvasStroke(page, canvas, {
				pointerType: "pen",
				points: [[0.2, 0.6], [0.8, 0.6]],
			});
			const afterTwo = await canvas.evaluate((c) => c.toDataURL("image/png"));
			expect(afterTwo).not.toBe(afterOne);

			await page.getByRole("button", { name: /Undo/i }).click();
			const afterUndo = await canvas.evaluate((c) => c.toDataURL("image/png"));
			expect(afterUndo).not.toBe(afterTwo);

			await page.getByRole("button", { name: /Redo/i }).click();
			const afterRedo = await canvas.evaluate((c) => c.toDataURL("image/png"));
			expect(afterRedo).toBe(afterTwo);

			await page.getByRole("button", { name: /Eraser/i }).click();
			await drawCanvasStroke(page, canvas, {
				pointerType: "pen",
				points: [[0.2, 0.6], [0.8, 0.6]],
			});
			const afterErase = await canvas.evaluate((c) => c.toDataURL("image/png"));
			expect(afterErase).not.toBe(afterRedo);
		} finally {
			await context.close();
			await stack.cleanup();
		}
	});

	test("T1-F10-03: Independent Light paper theme in Dark app produces high-contrast legible PNG export", async ({ browser }) => {
		const stack = await bootStack({ mockOptions: { chunkDelayMs: 5 } });
		const context = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-MD-PORT"]));
		const page = await context.newPage();
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			const chat = await createChatSession(stack.baseUrl, cookie, { title: "Paper Theme Contrast" });

			await loginBrowser(page, stack.baseUrl);
			await page.goto(`${stack.baseUrl}/chat/${chat.id}`);
			await composerInput(page).fill("[TRIGGER_FREE]");
			await page.getByRole("button", { name: "Send" }).click();
			await expect(page.getByTestId("question-dock")).toBeVisible({ timeout: 15_000 });

			await openDrawingPad(page);
			await page.getByRole("button", { name: /light/i }).click();

			const canvas = page.locator("canvas.drawing-pad-ink");
			await drawCanvasStroke(page, canvas, {
				pointerType: "pen",
				points: [[0.2, 0.25], [0.8, 0.75]],
			});

			await page.getByRole("button", { name: /Add to answer/i }).click();
			const previewImg = page.getByTestId("question-dock").locator("img").first();
			await expect(previewImg).toBeVisible();
			const src = await previewImg.getAttribute("src");
			expect(src).toBeTruthy();

			let exportedBuf;
			if (src.startsWith("data:")) {
				const match = /^data:image\/png;base64,(.+)$/i.exec(src);
				expect(match).toBeTruthy();
				exportedBuf = Buffer.from(match[1], "base64");
			} else if (src.startsWith("blob:")) {
				const b64 = await page.evaluate(async (blobUrl) => {
					const res = await fetch(blobUrl);
					const buf = new Uint8Array(await res.arrayBuffer());
					let bin = "";
					for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
					return btoa(bin);
				}, src);
				exportedBuf = Buffer.from(b64, "base64");
			} else {
				const exportedResp = await page.request.get(new URL(src, stack.baseUrl).toString());
				expect(exportedResp.status()).toBe(200);
				exportedBuf = await exportedResp.body();
			}
			const stats = assertPngContrast(exportedBuf, {
				expectedBackground: "light",
				minStrokePixels: 25,
				minContrastRatio: 3.0,
			});
			expect(stats.backgroundLuminance).toBeGreaterThanOrEqual(200);
		} finally {
			await context.close();
			await stack.cleanup();
		}
	});

	test("T1-F10-04: Per-question local draft persistence survives close/reopen without leaking to Q2", async ({ browser }) => {
		const stack = await bootStack({ mockOptions: { chunkDelayMs: 5 } });
		const context = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-MD-PORT"]));
		const page = await context.newPage();
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			const chat = await createChatSession(stack.baseUrl, cookie, { title: "Draft Persistence" });

			await loginBrowser(page, stack.baseUrl);
			await page.goto(`${stack.baseUrl}/chat/${chat.id}`);
			await composerInput(page).fill("[TRIGGER_FREE]");
			await page.getByRole("button", { name: "Send" }).click();
			await expect(page.getByTestId("question-dock")).toBeVisible({ timeout: 15_000 });

			await openDrawingPad(page);
			const canvas = page.locator("canvas.drawing-pad-ink");
			await expect(canvas).toBeVisible();
			const blankSnapshot = await canvas.evaluate((c) => c.toDataURL("image/png"));
			await drawCanvasStroke(page, canvas, {
				pointerType: "pen",
				points: [[0.25, 0.4], [0.75, 0.4]],
			});
			const drawnSnapshot = await canvas.evaluate((c) => c.toDataURL("image/png"));
			expect(drawnSnapshot).not.toBe(blankSnapshot);

			await page.getByRole("button", { name: /Close|×/i }).first().click();
			await openDrawingPad(page);
			const reopenedSnapshot = await canvas.evaluate((c) => c.toDataURL("image/png"));
			expect(reopenedSnapshot).toBe(drawnSnapshot);

			// Close Draw, answer Q1, and trigger Q2 in the same chat: Q2 Drawing Pad must open clean (zero Q1 draft leak)
			await page.getByRole("button", { name: /Close|×/i }).first().click();
			await questionInput(page, "answer").fill("Q1 completed text answer");
			await page.getByRole("button", { name: /Submit answer/i }).click();
			await expect(page.getByText(/Synthetic tutor response/i).last()).toBeVisible({ timeout: 15_000 });

			await composerInput(page).fill("[TRIGGER_FREE] Q2 follow-up");
			await page.getByRole("button", { name: "Send" }).click();
			await expect(page.getByTestId("question-dock")).toBeVisible({ timeout: 15_000 });
			await openDrawingPad(page);
			await expect(canvas).toBeVisible();
			const q2InitialSnapshot = await canvas.evaluate((c) => c.toDataURL("image/png"));
			expect(q2InitialSnapshot).not.toBe(drawnSnapshot);
			expect(q2InitialSnapshot).toBe(blankSnapshot);
		} finally {
			await context.close();
			await stack.cleanup();
		}
	});

	test("T1-F10-05: Add to answer stages PNG preview for both Free-Response and Multiple-Choice", async ({ browser }) => {
		const stack = await bootStack({ mockOptions: { chunkDelayMs: 5 } });
		const context = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-MD-PORT"]));
		const page = await context.newPage();
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			const freeChat = await createChatSession(stack.baseUrl, cookie, { title: "Stage Free" });
			const mcChat = await createChatSession(stack.baseUrl, cookie, { title: "Stage MC" });

			await loginBrowser(page, stack.baseUrl);

			for (const [cId, trigger] of [[freeChat.id, "[TRIGGER_FREE]"], [mcChat.id, "[TRIGGER_MC]"]]) {
				await page.goto(`${stack.baseUrl}/chat/${cId}`);
				await composerInput(page).fill(trigger);
				await page.getByRole("button", { name: "Send" }).click();
				await expect(page.getByTestId("question-dock")).toBeVisible({ timeout: 15_000 });

				await stack.mock.clearRequests();
				await openDrawingPad(page);
				const canvas = page.locator("canvas.drawing-pad-ink");
				await drawCanvasStroke(page, canvas, {
					pointerType: "pen",
					points: [[0.2, 0.5], [0.7, 0.5]],
				});
				await page.getByRole("button", { name: /Add to answer/i }).click();
				await expect(page.getByTestId("question-dock").locator("img")).toBeVisible();
				expect((await stack.mock.getRequests()).count).toBe(0);
			}
		} finally {
			await context.close();
			await stack.cleanup();
		}
	});

	test("T1-F10-06: Pointer parity across mouse, touch, and Apple Pencil (pen)", async ({ browser }) => {
		const stack = await bootStack();
		const context = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-MD-PORT"]));
		const page = await context.newPage();
		try {
			await loginBrowser(page, stack.baseUrl);
			await page.goto(`${stack.baseUrl}/chat/chat_synth_teach_01`);
			await openDrawingPad(page);
			const canvas = page.locator("canvas.drawing-pad-ink");
			await expect(canvas).toBeVisible();

			const touchAction = await canvas.evaluate((c) => getComputedStyle(c).touchAction);
			expect(touchAction).toBe("none");

			let prev = await canvas.evaluate((c) => c.toDataURL("image/png"));
			for (const [idx, pointerType] of ["mouse", "touch", "pen"].entries()) {
				const y = 0.25 + idx * 0.2;
				await drawCanvasStroke(page, canvas, {
					pointerType,
					points: [[0.2, y], [0.7, y]],
				});
				const next = await canvas.evaluate((c) => c.toDataURL("image/png"));
				expect(next).not.toBe(prev);
				prev = next;
			}
		} finally {
			await context.close();
			await stack.cleanup();
		}
	});
});

test.describe("Tier 1 — F11: iPadOS Safari / WebKit Responsive Shell & Touch Ergonomics", () => {
	test("T1-F11-01: iPad overlay drawer sidebar at 820x1180 never squeezes main column", async ({ browser }) => {
		const stack = await bootStack();
		const context = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-MD-PORT"]));
		const page = await context.newPage();
		try {
			await loginBrowser(page, stack.baseUrl);
			await page.goto(`${stack.baseUrl}/chat/chat_synth_teach_01`);
			await assertNoHorizontalOverflow(page);

			const openBtn = page.getByRole("button", { name: /Open sidebar/i });
			if (await openBtn.isVisible()) {
				await openBtn.tap();
			}
			await expect(page.getByTestId("new-session")).toBeVisible();
			await assertNoHorizontalOverflow(page);
		} finally {
			await context.close();
			await stack.cleanup();
		}
	});

	test("T1-F11-02: Onscreen keyboard (visualViewport shrink) keeps QuestionDock & Submit reachable", async ({ browser }) => {
		const stack = await bootStack({ mockOptions: { chunkDelayMs: 5 } });
		const context = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-SM-PORT"]));
		const page = await context.newPage();
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			const chat = await createChatSession(stack.baseUrl, cookie, { title: "Keyboard Clearance" });

			await loginBrowser(page, stack.baseUrl);
			await page.goto(`${stack.baseUrl}/chat/${chat.id}`);
			await composerInput(page).fill("[TRIGGER_FREE]");
			await page.getByRole("button", { name: "Send" }).click();

			const freeInput = questionInput(page, "answer");
			await expect(freeInput).toBeVisible({ timeout: 15_000 });
			await freeInput.tap();

			// Simulate iPadOS onscreen keyboard shrinking visualViewport height by 360px
			// while window.innerHeight remains 1133 (CSS layout viewport unchanged).
			const vpState = await page.evaluate(() => {
				const initialInnerHeight = window.innerHeight;
				const shrunkHeight = initialInnerHeight - 360;
				if (window.visualViewport) {
					Object.defineProperty(window.visualViewport, "height", {
						configurable: true,
						get: () => shrunkHeight,
					});
					window.visualViewport.dispatchEvent(new Event("resize"));
				}
				return {
					initialInnerHeight,
					afterInnerHeight: window.innerHeight,
					visualViewportHeight: window.visualViewport?.height ?? null,
				};
			});
			expect(vpState.initialInnerHeight).toBe(1133);
			expect(vpState.afterInnerHeight).toBe(1133);
			expect(vpState.visualViewportHeight).toBe(1133 - 360);

			const submitBtn = page.getByRole("button", { name: /Submit answer/i });
			await submitBtn.scrollIntoViewIfNeeded();
			const box = await submitBtn.boundingBox();
			expect(box).toBeTruthy();
			expect(box.y + box.height).toBeLessThanOrEqual(1133 - 360 + 2);
			await expect(freeInput).toBeVisible();
			await assertNoHorizontalOverflow(page);
		} finally {
			await context.close();
			await stack.cleanup();
		}
	});

	test("T1-F11-03: Touch equivalents open side-question / controls without hover", async ({ browser }) => {
		const stack = await bootStack();
		const context = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-MD-PORT"]));
		const page = await context.newPage();
		try {
			await loginBrowser(page, stack.baseUrl);
			await page.goto(`${stack.baseUrl}/chat/chat_synth_teach_01`);
			await assertTouchTargets(page, ['[aria-label="Open sidebar"]', '[data-testid="stats-model"]']);
			const prose = page.getByText(/trajectory forms a parabola/i).first();
			await expect(prose).toBeVisible();
			await prose.tap();

			const sideBtn = page.getByTestId("side-conversation-button").first();
			await expect(sideBtn).toBeVisible();
			await sideBtn.tap();
			await expect(page.getByTestId("side-thread")).toBeVisible();
		} finally {
			await context.close();
			await stack.cleanup();
		}
	});

	test("T1-F11-04: Orientation & Split-View state preservation keeps MC choice, text, and drawing draft", async ({ browser }) => {
		const stack = await bootStack({ mockOptions: { chunkDelayMs: 5 } });
		const context = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-MD-PORT"]));
		const page = await context.newPage();
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			const chat = await createChatSession(stack.baseUrl, cookie, { title: "Orientation State" });

			await loginBrowser(page, stack.baseUrl);
			await page.goto(`${stack.baseUrl}/chat/${chat.id}`);
			await composerInput(page).fill("[TRIGGER_MC]");
			await page.getByRole("button", { name: "Send" }).click();

			await expect(page.getByTestId("question-dock")).toBeVisible({ timeout: 15_000 });
			await page.getByRole("radio").nth(1).click();
			await questionInput(page, "thinking").fill("Preserved orientation reasoning");

			// Also create a Drawing Pad draft before rotating / resizing to Split View
			await openDrawingPad(page);
			const canvas = page.locator("canvas.drawing-pad-ink");
			await expect(canvas).toBeVisible();
			await drawCanvasStroke(page, canvas, {
				pointerType: "pen",
				points: [[0.2, 0.35], [0.8, 0.65]],
			});
			const drawnDataUrl = await canvas.evaluate((c) => c.toDataURL("image/png"));
			const drawnStats = analyzePngPixels(Buffer.from(drawnDataUrl.replace(/^data:image\/png;base64,/, ""), "base64"));
			expect(drawnStats.strokePixelCount).toBeGreaterThan(0);
			await closeDrawingPad(page);
			await expect(canvas).toBeHidden();

			await page.setViewportSize({ width: 1180, height: 820 });
			await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([1180, 820]);
			await page.setViewportSize({ width: 375, height: 1024 });

			await expect(page.getByRole("radio").nth(1)).toHaveAttribute("aria-checked", "true");
			await expect(questionInput(page, "thinking")).toContainText("Preserved orientation reasoning");

			await openDrawingPad(page);
			await expect(canvas).toBeVisible();
			const reopenedDataUrl = await canvas.evaluate((c) => c.toDataURL("image/png"));
			const reopenedStats = analyzePngPixels(Buffer.from(reopenedDataUrl.replace(/^data:image\/png;base64,/, ""), "base64"));
			expect(reopenedStats.strokePixelCount).toBeGreaterThan(0);
		} finally {
			await context.close();
			await stack.cleanup();
		}
	});

	test("T1-F11-05: Safe-area & MenuShell viewport clamping on 744x1133 and 375x1024", async ({ browser }) => {
		const stack = await bootStack();
		const context = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-SM-PORT"]));
		const page = await context.newPage();
		try {
			await loginBrowser(page, stack.baseUrl);
			await page.goto(`${stack.baseUrl}/chat/chat_synth_teach_01`);
			for (const vp of [VIEWPORT_MATRIX["VP-SM-PORT"], VIEWPORT_MATRIX["VP-SPLIT-1"]]) {
				await page.setViewportSize({ width: vp.width, height: vp.height });
				await page.getByTestId("stats-model").tap();
				await expect(page.getByTestId("model-menu")).toBeVisible();
				await assertPopoversInViewport(page);
				await page.keyboard.press("Escape");
			}
		} finally {
			await context.close();
			await stack.cleanup();
		}
	});
});

test.describe("Tier 1 — F12: Playwright WebKit iPad Viewport Matrix & Manual Checklist", () => {
	async function runMatrixCheck(browser, stack, vpKeys) {
		for (const key of vpKeys) {
			const vp = VIEWPORT_MATRIX[key];
			const context = await browser.newContext(viewportContextOptions(vp));
			const page = await context.newPage();
			try {
				await loginBrowser(page, stack.baseUrl);
				await page.goto(`${stack.baseUrl}/chat/chat_synth_teach_01`);
				await assertNoHorizontalOverflow(page);
				await page.getByTestId("stats-model").click();
				await expect(page.getByTestId("model-menu")).toBeVisible();
				await assertPopoversInViewport(page);
				await page.keyboard.press("Escape");
				await assertTouchTargets(page, ['[data-testid="stats-model"]', '[aria-label="Send"]']);
			} finally {
				await context.close();
			}
		}
	}

	test("T1-F12-01: Small iPad matrix pass (VP-SM-PORT 744x1133, VP-SM-LAND 1133x744)", async ({ browser }) => {
		const stack = await bootStack();
		try {
			await runMatrixCheck(browser, stack, ["VP-SM-PORT", "VP-SM-LAND"]);
		} finally {
			await stack.cleanup();
		}
	});

	test("T1-F12-02: Medium iPad matrix pass (VP-MD-PORT 820x1180, VP-MD-LAND 1180x820)", async ({ browser }) => {
		const stack = await bootStack();
		try {
			await runMatrixCheck(browser, stack, ["VP-MD-PORT", "VP-MD-LAND"]);
		} finally {
			await stack.cleanup();
		}
	});

	test("T1-F12-03: Large iPad matrix pass (VP-LG-PORT 1024x1366, VP-LG-LAND 1366x1024)", async ({ browser }) => {
		const stack = await bootStack();
		try {
			await runMatrixCheck(browser, stack, ["VP-LG-PORT", "VP-LG-LAND"]);
		} finally {
			await stack.cleanup();
		}
	});

	test("T1-F12-04: Narrow Split-View matrix pass (VP-SPLIT-1 375x1024, VP-SPLIT-2 507x1180)", async ({ browser }) => {
		const stack = await bootStack();
		try {
			await runMatrixCheck(browser, stack, ["VP-SPLIT-1", "VP-SPLIT-2"]);
		} finally {
			await stack.cleanup();
		}
	});

	test("T1-F12-05: Viewport matrix CSS-px definitions & documentation alignment", async ({}, testInfo) => {
		const requiredIpadViewports = [
			["VP-SM-PORT", 744, 1133],
			["VP-SM-LAND", 1133, 744],
			["VP-MD-PORT", 820, 1180],
			["VP-MD-LAND", 1180, 820],
			["VP-LG-PORT", 1024, 1366],
			["VP-LG-LAND", 1366, 1024],
			["VP-SPLIT-1", 375, 1024],
			["VP-SPLIT-2", 507, 1180],
		];
		const documentedRows = [];
		for (const [id, w, h] of requiredIpadViewports) {
			expect(VIEWPORT_MATRIX[id].width).toBe(w);
			expect(VIEWPORT_MATRIX[id].height).toBe(h);
			expect(VIEWPORT_MATRIX[id].hasTouch).toBe(true);
			expect(VIEWPORT_MATRIX[id].isMobile).toBe(true);
			expect(VIEWPORT_MATRIX[id].deviceScaleFactor).toBe(2);
			documentedRows.push(`${id}: ${w}x${h} CSS px (touch=true, dpr=2)`);
		}
		expect(VIEWPORT_MATRIX["VP-DESK-REF"]).toEqual({
			width: 1440,
			height: 900,
			hasTouch: false,
			isMobile: false,
			deviceScaleFactor: 1,
		});
		documentedRows.push("VP-DESK-REF: 1440x900 CSS px (touch=false, dpr=1)");

		const summary = documentedRows.join("\n");
		console.log(`[T1-F12-05] Documented CSS-px Viewport Matrix:\n${summary}`);
		await testInfo.attach("viewport-matrix-css-px", {
			body: Buffer.from(`${summary}\n`, "utf8"),
			contentType: "text/plain",
		});

		const configPath = path.join(resolveRepoDir(), "tests", "e2e", "helpers", "e2e-session.mjs");
		expect(fs.existsSync(configPath)).toBe(true);
	});

	test("T1-F12-06: Desktop Reference Client (VP-DESK-REF 1440x900) layout & cross-device parity", async ({ browser }) => {
		const stack = await bootStack();
		const context = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-DESK-REF"]));
		const page = await context.newPage();
		try {
			await loginBrowser(page, stack.baseUrl);
			await page.goto(`${stack.baseUrl}/chat/chat_synth_teach_01`);
			await assertNoHorizontalOverflow(page);
			await expect(page.getByTestId("composer")).toBeVisible();
			await expect(page.getByTestId("stats-model")).toBeVisible();
		} finally {
			await context.close();
			await stack.cleanup();
		}
	});
});
