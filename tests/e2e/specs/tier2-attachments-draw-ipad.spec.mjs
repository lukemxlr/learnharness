import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { resolveRepoDir } from "../harness/server-controller.mjs";
import {
	addDrawingToAnswer,
	assertCanvasTouchActionNone,
	assertCleanCanvasComparedTo,
	assertExportedDrawingContrast,
	closeDrawingPad,
	dispatchClipboardPaste,
	drawCanvasStroke,
	drawingCanvas,
	getCanvasSnapshot,
	openDrawingPad,
	selectDrawingTool,
	selectPenColor,
	selectStrokeWidth,
	setPaperTheme,
	toggleKarorasterGrid,
	toggleQuestionContext,
} from "../helpers/drawing-pad.mjs";
import {
	bootStack,
	composerInput,
	createChatSession,
	loginApi,
	loginBrowser,
	questionInput,
} from "../helpers/e2e-session.mjs";
import {
	assertClosedSidebarNotOverlapping,
	assertElementsInViewport,
	assertElementUnoccluded,
	assertKeyboardClearance,
	assertNoHorizontalOverflow,
	assertPopoversInViewport,
	assertResponsiveShell,
	assertScrollableContainerContained,
	assertTouchTargets,
	simulateOnscreenKeyboard,
} from "../helpers/layout-assertions.mjs";
import {
	buildSample3PagePdf,
	createSolidPng,
	createVectorDiagramPng,
} from "../helpers/test-assets.mjs";
import {
	ALL_VIEWPORT_KEYS,
	applyViewport,
	EXTREME_SPLIT_VIEWPORT,
	formatViewportSummary,
	IPAD_VIEWPORT_KEYS,
	VIEWPORT_MATRIX,
	viewportContextOptions,
} from "../helpers/viewport-matrix.mjs";

test.describe("Tier 2 — F9: Attachment Edge Cases, Errors & Multi-Modal Paste", () => {
	test("T2-F9-01: Upload 500 failure preserves MC selection & reasoning draft", async ({ browser }) => {
		const stack = await bootStack({ mockOptions: { chunkDelayMs: 5 } });
		const context = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-DESK-REF"]));
		const page = await context.newPage();
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			const chat = await createChatSession(stack.baseUrl, cookie, { title: "Upload 500 Draft Guard" });
			const png = createVectorDiagramPng(48, 36);

			await loginBrowser(page, stack.baseUrl);
			await page.goto(`${stack.baseUrl}/chat/${chat.id}`);
			await composerInput(page).fill("[TRIGGER_MC]");
			await page.getByRole("button", { name: "Send" }).click();

			const dock = page.getByTestId("question-dock");
			await expect(dock).toBeVisible({ timeout: 15_000 });
			await page.getByRole("radio").nth(1).click();
			await expect(page.getByRole("radio").nth(1)).toHaveAttribute("aria-checked", "true");

			const mcInput = questionInput(page, "thinking");
			await mcInput.fill("Horizontal velocity remains constant when air resistance is neglected");

			await page.route("**/api/attachments", async (route) => {
				if (route.request().method() === "POST") {
					return route.fulfill({
						status: 500,
						contentType: "application/json",
						body: JSON.stringify({ error: "Simulated attachment storage failure" }),
					});
				}
				return route.continue();
			});

			await dispatchClipboardPaste(mcInput, { pngBuffer: png });

			await expect(dock.getByRole("alert").or(page.getByText(/failed|error|upload/i)).first()).toBeVisible({
				timeout: 10_000,
			});
			await expect(page.getByRole("radio").nth(1)).toHaveAttribute("aria-checked", "true");
			await expect(mcInput).toContainText("Horizontal velocity remains constant");
			await expect(dock.locator("img")).toHaveCount(0);
		} finally {
			await context.close();
			await stack.cleanup();
		}
	});

	test("T2-F9-02: Empty, plain-text, and HTML-only clipboard paste into PathInput", async ({ browser }) => {
		const stack = await bootStack({ mockOptions: { chunkDelayMs: 5 } });
		const context = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-DESK-REF"]));
		const page = await context.newPage();
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			const chat = await createChatSession(stack.baseUrl, cookie, { title: "Clipboard Paste Matrix" });

			await loginBrowser(page, stack.baseUrl);
			await page.goto(`${stack.baseUrl}/chat/${chat.id}`);
			await composerInput(page).fill("[TRIGGER_FREE]");
			await page.getByRole("button", { name: "Send" }).click();

			const dock = page.getByTestId("question-dock");
			const freeInput = questionInput(page, "answer");
			await expect(freeInput).toBeVisible({ timeout: 15_000 });
			await freeInput.fill("Initial draft: ");

			// Empty clipboard paste creates zero bogus previews and leaves draft intact
			await dispatchClipboardPaste(freeInput, {});
			await expect(dock.locator("img")).toHaveCount(0);
			await expect(freeInput).toContainText("Initial draft:");

			// HTML-only paste creates zero bogus image previews
			await dispatchClipboardPaste(freeInput, { html: "<strong>v_x</strong>" });
			await expect(dock.locator("img")).toHaveCount(0);
			await expect(freeInput).toContainText("Initial draft:");

			// Plain-text paste inserts cleanly without bogus attachments
			await dispatchClipboardPaste(freeInput, { text: "v_x = v_0 cos(theta)" });
			await expect(dock.locator("img")).toHaveCount(0);
			await expect(freeInput).toContainText("v_x = v_0 cos(theta)");
		} finally {
			await context.close();
			await stack.cleanup();
		}
	});

	test("T2-F9-03: Corrupt / non-PDF text file renamed to fake.pdf rejected", async ({ browser }) => {
		const stack = await bootStack({ mockOptions: { chunkDelayMs: 5 } });
		const context = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-DESK-REF"]));
		const page = await context.newPage();
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			const fakePdf = Buffer.from("not a pdf header, just plain text", "utf8");

			// API-level rejection
			const form = new FormData();
			form.append("file", new Blob([fakePdf], { type: "application/pdf" }), "fake.pdf");
			const apiRes = await fetch(`${stack.baseUrl}/api/attachments`, {
				method: "POST",
				headers: { Cookie: cookie },
				body: form,
			});
			expect([400, 415]).toContain(apiRes.status);
			const apiErr = await apiRes.json();
			expect(typeof apiErr.error).toBe("string");

			// UI picker rejection
			const chat = await createChatSession(stack.baseUrl, cookie, { title: "Corrupt PDF UI Check" });
			await loginBrowser(page, stack.baseUrl);
			await page.goto(`${stack.baseUrl}/chat/${chat.id}`);

			await page.getByTestId("attach-files-input").setInputFiles({
				name: "fake.pdf",
				mimeType: "application/pdf",
				buffer: fakePdf,
			});

			await expect(page.getByRole("alert").or(page.getByText(/invalid|unsupported|pdf|failed/i)).first()).toBeVisible({
				timeout: 10_000,
			});
			await expect(page.getByTestId("composer")).toBeVisible();
			await expect(page.getByTestId("composer").getByText("fake.pdf")).toHaveCount(0);
		} finally {
			await context.close();
			await stack.cleanup();
		}
	});

	test("T2-F9-04: Combined Ctrl+V screenshot + file-picker PNG in same Free-Response", async ({ browser }) => {
		const stack = await bootStack({ mockOptions: { chunkDelayMs: 5 } });
		const context = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-DESK-REF"]));
		const page = await context.newPage();
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			const chat = await createChatSession(stack.baseUrl, cookie, { title: "Combined Paste + Picker" });
			const pngPaste = createSolidPng(32, 32, [220, 38, 38, 255]);
			const pngPick = createVectorDiagramPng(48, 36);
			const shaPaste = createHash("sha256").update(pngPaste).digest("hex").slice(0, 12);
			const shaPick = createHash("sha256").update(pngPick).digest("hex").slice(0, 12);

			await loginBrowser(page, stack.baseUrl);
			await page.goto(`${stack.baseUrl}/chat/${chat.id}`);
			await composerInput(page).fill("[TRIGGER_FREE]");
			await page.getByRole("button", { name: "Send" }).click();

			const dock = page.getByTestId("question-dock");
			const freeInput = questionInput(page, "answer");
			await expect(freeInput).toBeVisible({ timeout: 15_000 });

			await dispatchClipboardPaste(freeInput, { pngBuffer: pngPaste, filename: "pasted-shot.png" });
			await expect(dock.locator("img")).toHaveCount(1);

			const dockFileInput = dock.locator('input[type="file"]').first();
			const pickerInput = (await dockFileInput.count()) > 0 ? dockFileInput : page.getByTestId("attach-files-input");
			await pickerInput.setInputFiles({
				name: "picked-diagram.png",
				mimeType: "image/png",
				buffer: pngPick,
			});

			await expect(dock.locator("img")).toHaveCount(2);
			await freeInput.fill("[ECHO_VISION] combined attachments");
			await stack.mock.clearRequests();
			await page.getByRole("button", { name: /Submit answer/i }).click();

			await expect(page.getByText(/VISION_ECHO count=2/)).toBeVisible({ timeout: 15_000 });
			const ledger = await stack.mock.getRequests();
			const last = ledger.requests[ledger.requests.length - 1];
			expect(last.images.length).toBe(2);
			const hashes = last.images.map((img) => img.sha256);
			expect(hashes.some((h) => h.includes(shaPaste))).toBe(true);
			expect(hashes.some((h) => h.includes(shaPick))).toBe(true);
		} finally {
			await context.close();
			await stack.cleanup();
		}
	});

	test("T2-F9-05: Submit disabled/guarded during active upload", async ({ browser }) => {
		const stack = await bootStack({ mockOptions: { chunkDelayMs: 5 } });
		const context = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-DESK-REF"]));
		const page = await context.newPage();
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			const chat = await createChatSession(stack.baseUrl, cookie, { title: "Upload Pending Guard" });
			const png = createVectorDiagramPng(48, 36);

			await loginBrowser(page, stack.baseUrl);
			await page.goto(`${stack.baseUrl}/chat/${chat.id}`);
			await composerInput(page).fill("[TRIGGER_FREE]");
			await page.getByRole("button", { name: "Send" }).click();

			const dock = page.getByTestId("question-dock");
			const freeInput = questionInput(page, "answer");
			await expect(freeInput).toBeVisible({ timeout: 15_000 });
			await freeInput.fill("[ECHO_VISION] wait for upload");

			let releaseUpload;
			const holdRelease = new Promise((r) => {
				releaseUpload = r;
			});
			let resolveUploadStarted;
			const uploadStarted = new Promise((resolve) => {
				resolveUploadStarted = resolve;
			});
			await page.route("**/api/attachments", async (route) => {
				if (route.request().method() === "POST") {
					resolveUploadStarted();
					const response = await route.fetch();
					await holdRelease;
					return route.fulfill({ response });
				}
				return route.continue();
			});

			await dispatchClipboardPaste(freeInput, { pngBuffer: png });
			await uploadStarted;

			const submitBtn = page.getByRole("button", { name: /Submit answer/i });
			await expect(submitBtn).toBeDisabled();

			releaseUpload();
			await expect(dock.locator("img")).toHaveCount(1, { timeout: 10_000 });
			await expect(submitBtn).toBeEnabled();

			await stack.mock.clearRequests();
			await submitBtn.click();
			await expect(page.getByText(/VISION_ECHO count=1/)).toBeVisible({ timeout: 15_000 });
			expect((await stack.mock.getRequests()).requests.at(-1).images.length).toBe(1);
		} finally {
			await context.close();
			await stack.cleanup();
		}
	});
});

test.describe("Tier 2 — F10: Drawing Pad Contrast, Stack Boundaries & Draft Scoping", () => {
	test("T2-F10-01: Light paper inside Dark app exported PNG pixel contrast", async ({ browser }) => {
		const stack = await bootStack({ mockOptions: { chunkDelayMs: 5 } });
		const context = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-MD-PORT"]));
		const page = await context.newPage();
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			await fetch(`${stack.baseUrl}/api/settings/appearance`, {
				method: "PUT",
				headers: { "Content-Type": "application/json", Cookie: cookie },
				body: JSON.stringify({ theme: "default" }),
			});
			const chat = await createChatSession(stack.baseUrl, cookie, { title: "Light Paper in Dark App" });

			await loginBrowser(page, stack.baseUrl);
			await page.goto(`${stack.baseUrl}/chat/${chat.id}`);
			await composerInput(page).fill("[TRIGGER_FREE]");
			await page.getByRole("button", { name: "Send" }).click();
			await expect(page.getByTestId("question-dock")).toBeVisible({ timeout: 15_000 });

			await openDrawingPad(page);
			await setPaperTheme(page, "light");
			await selectPenColor(page, /black|ink|#111|dark/i);
			await drawCanvasStroke(page, drawingCanvas(page), {
				pointerType: "pen",
				points: [[0.2, 0.25], [0.8, 0.25]],
			});
			await selectPenColor(page, /blue/i);
			await drawCanvasStroke(page, drawingCanvas(page), {
				pointerType: "pen",
				points: [[0.2, 0.65], [0.8, 0.65]],
			});

			await addDrawingToAnswer(page);
			const previewImg = page.getByTestId("question-dock").locator("img").first();
			await expect(previewImg).toBeVisible();
			const stats = await assertExportedDrawingContrast(page, stack.baseUrl, previewImg, {
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

	test("T2-F10-02: Dark paper exported PNG pixel contrast", async ({ browser }) => {
		const stack = await bootStack({ mockOptions: { chunkDelayMs: 5 } });
		const context = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-MD-PORT"]));
		const page = await context.newPage();
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			const chat = await createChatSession(stack.baseUrl, cookie, { title: "Dark Paper Contrast" });

			await loginBrowser(page, stack.baseUrl);
			await page.goto(`${stack.baseUrl}/chat/${chat.id}`);
			await composerInput(page).fill("[TRIGGER_FREE]");
			await page.getByRole("button", { name: "Send" }).click();
			await expect(page.getByTestId("question-dock")).toBeVisible({ timeout: 15_000 });

			await openDrawingPad(page);
			await setPaperTheme(page, "dark");
			await selectPenColor(page, /white|yellow|cyan|light|blue/i);
			await selectStrokeWidth(page, 8);
			await drawCanvasStroke(page, drawingCanvas(page), {
				pointerType: "pen",
				points: [[0.2, 0.3], [0.8, 0.7]],
			});

			await addDrawingToAnswer(page);
			const previewImg = page.getByTestId("question-dock").locator("img").first();
			await expect(previewImg).toBeVisible();
			const stats = await assertExportedDrawingContrast(page, stack.baseUrl, previewImg, {
				expectedBackground: "dark",
				minStrokePixels: 25,
				minContrastRatio: 3.0,
			});
			expect(stats.backgroundLuminance).toBeLessThanOrEqual(70);
		} finally {
			await context.close();
			await stack.cleanup();
		}
	});

	test("T2-F10-03: Empty Drawing Pad Add to answer behavior", async ({ browser }) => {
		const stack = await bootStack({ mockOptions: { chunkDelayMs: 5 } });
		const context = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-MD-PORT"]));
		const page = await context.newPage();
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			const chat = await createChatSession(stack.baseUrl, cookie, { title: "Empty Drawing Guard" });

			await loginBrowser(page, stack.baseUrl);
			await page.goto(`${stack.baseUrl}/chat/${chat.id}`);
			await composerInput(page).fill("[TRIGGER_FREE]");
			await page.getByRole("button", { name: "Send" }).click();
			const dock = page.getByTestId("question-dock");
			await expect(dock).toBeVisible({ timeout: 15_000 });

			await openDrawingPad(page);
			const surface = page.locator("[data-plugin-session-surface]").first();
			const addBtn = surface.getByRole("button", { name: /Add to answer/i });
			if (await addBtn.isEnabled()) {
				await addBtn.click();
			}
			await expect(dock.locator("img")).toHaveCount(0);

			// Draw 1 stroke then clear/undo back to blank and verify blank sheet cannot be staged
			await drawCanvasStroke(page, drawingCanvas(page), {
				pointerType: "pen",
				points: [[0.3, 0.4], [0.6, 0.4]],
			});
			await selectDrawingTool(page, "undo");
			await assertCleanCanvasComparedTo(drawingCanvas(page));
			if (await addBtn.isEnabled()) {
				await addBtn.click();
			}
			await expect(dock.locator("img")).toHaveCount(0);
		} finally {
			await context.close();
			await stack.cleanup();
		}
	});

	test("T2-F10-04: Undo/Redo stack boundary & post-Undo branch truncation", async ({ browser }) => {
		const stack = await bootStack();
		const context = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-MD-PORT"]));
		const page = await context.newPage();
		try {
			await loginBrowser(page, stack.baseUrl);
			await page.goto(`${stack.baseUrl}/chat/chat_synth_teach_01`);
			const canvas = await openDrawingPad(page);

			const snap0 = await getCanvasSnapshot(canvas);
			await drawCanvasStroke(page, canvas, { pointerType: "pen", points: [[0.2, 0.25], [0.7, 0.25]] });
			const snap1 = await getCanvasSnapshot(canvas);
			await drawCanvasStroke(page, canvas, { pointerType: "pen", points: [[0.2, 0.45], [0.7, 0.45]] });
			const snap2 = await getCanvasSnapshot(canvas);
			await drawCanvasStroke(page, canvas, { pointerType: "pen", points: [[0.2, 0.65], [0.7, 0.65]] });
			const snap3 = await getCanvasSnapshot(canvas);

			expect(snap1.dataUrl).not.toBe(snap0.dataUrl);
			expect(snap2.dataUrl).not.toBe(snap1.dataUrl);
			expect(snap3.dataUrl).not.toBe(snap2.dataUrl);

			await selectDrawingTool(page, "undo");
			await selectDrawingTool(page, "undo");
			expect((await getCanvasSnapshot(canvas)).dataUrl).toBe(snap1.dataUrl);

			await selectDrawingTool(page, "redo");
			expect((await getCanvasSnapshot(canvas)).dataUrl).toBe(snap2.dataUrl);

			// Drawing new branch stroke 4 truncates prior redo branch (snap3)
			await drawCanvasStroke(page, canvas, { pointerType: "pen", points: [[0.2, 0.8], [0.7, 0.8]] });
			const snap4 = await getCanvasSnapshot(canvas);
			expect(snap4.dataUrl).not.toBe(snap3.dataUrl);

			const surface = page.locator("[data-plugin-session-surface]").first();
			const redoBtn = surface.getByRole("button", { name: /\bredo\b/i }).first();
			await expect(redoBtn).toBeDisabled();

			await selectDrawingTool(page, "undo");
			expect((await getCanvasSnapshot(canvas)).dataUrl).toBe(snap2.dataUrl);
			await selectDrawingTool(page, "undo");
			expect((await getCanvasSnapshot(canvas)).dataUrl).toBe(snap1.dataUrl);
			await selectDrawingTool(page, "undo");
			expect((await getCanvasSnapshot(canvas)).dataUrl).toBe(snap0.dataUrl);

			const undoBtn = surface.getByRole("button", { name: /\bundo\b/i }).first();
			await expect(undoBtn).toBeDisabled();
		} finally {
			await context.close();
			await stack.cleanup();
		}
	});

	test("T2-F10-05: Cancel/close Drawing Pad without Add to answer keeps local draft only", async ({ browser }) => {
		const stack = await bootStack({ mockOptions: { chunkDelayMs: 5 } });
		const context = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-MD-PORT"]));
		const page = await context.newPage();
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			const chat = await createChatSession(stack.baseUrl, cookie, { title: "Close Keeps Draft Only" });

			await loginBrowser(page, stack.baseUrl);
			await page.goto(`${stack.baseUrl}/chat/${chat.id}`);
			await composerInput(page).fill("[TRIGGER_FREE]");
			await page.getByRole("button", { name: "Send" }).click();
			const dock = page.getByTestId("question-dock");
			await expect(dock).toBeVisible({ timeout: 15_000 });

			await stack.mock.clearRequests();
			const canvas = await openDrawingPad(page);
			await drawCanvasStroke(page, canvas, { pointerType: "pen", points: [[0.2, 0.35], [0.8, 0.65]] });
			const drawn = await getCanvasSnapshot(canvas);

			await closeDrawingPad(page);
			await expect(dock.locator("img")).toHaveCount(0);
			expect((await stack.mock.getRequests()).count).toBe(0);

			const reopenedCanvas = await openDrawingPad(page);
			expect((await getCanvasSnapshot(reopenedCanvas)).dataUrl).toBe(drawn.dataUrl);
		} finally {
			await context.close();
			await stack.cleanup();
		}
	});

	test("T2-F10-06: Drawing draft cleared/scoped after regular answer submit", async ({ browser }) => {
		const stack = await bootStack({ mockOptions: { chunkDelayMs: 5 } });
		const context = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-MD-PORT"]));
		const page = await context.newPage();
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			const chat = await createChatSession(stack.baseUrl, cookie, { title: "Drawing Draft Cleared on Submit" });

			await loginBrowser(page, stack.baseUrl);
			await page.goto(`${stack.baseUrl}/chat/${chat.id}`);
			await composerInput(page).fill("[TRIGGER_FREE] Q1");
			await page.getByRole("button", { name: "Send" }).click();
			await expect(page.getByTestId("question-dock")).toBeVisible({ timeout: 15_000 });

			const canvas = await openDrawingPad(page);
			await drawCanvasStroke(page, canvas, { pointerType: "pen", points: [[0.2, 0.3], [0.75, 0.7]] });
			const q1Snap = await getCanvasSnapshot(canvas);
			await addDrawingToAnswer(page);
			await questionInput(page, "answer").fill("[ECHO_VISION] Q1 drawing answer");
			await page.getByRole("button", { name: /Submit answer/i }).click();

			await expect(page.getByText(/VISION_ECHO count=1/)).toBeVisible({ timeout: 15_000 });
			await expect(page.locator("main img").first()).toBeVisible();

			await composerInput(page).fill("[TRIGGER_FREE] Q2");
			await page.getByRole("button", { name: "Send" }).click();
			await expect(page.getByTestId("question-dock")).toBeVisible({ timeout: 15_000 });

			const q2Canvas = await openDrawingPad(page);
			await assertCleanCanvasComparedTo(q2Canvas, q1Snap.dataUrl);
		} finally {
			await context.close();
			await stack.cleanup();
		}
	});
});

test.describe("Tier 2 — F11: iPad Edge Responsive & Keyboard Interaction Cases", () => {
	test("T2-F11-01: Onscreen keyboard open on 744x1133 with MC + staged drawing preview", async ({ browser }) => {
		const stack = await bootStack({ mockOptions: { chunkDelayMs: 5 } });
		const context = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-SM-PORT"]));
		const page = await context.newPage();
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			const chat = await createChatSession(stack.baseUrl, cookie, { title: "Keyboard MC Preview" });

			await loginBrowser(page, stack.baseUrl);
			await page.goto(`${stack.baseUrl}/chat/${chat.id}`);
			await composerInput(page).fill("[TRIGGER_MC]");
			await page.getByRole("button", { name: "Send" }).click();
			const dock = page.getByTestId("question-dock");
			await expect(dock).toBeVisible({ timeout: 15_000 });

			await page.getByRole("radio").nth(0).click();
			await openDrawingPad(page);
			await drawCanvasStroke(page, drawingCanvas(page), { pointerType: "pen", points: [[0.2, 0.4], [0.8, 0.4]] });
			await addDrawingToAnswer(page);
			await expect(dock.locator("img")).toBeVisible();

			const mcInput = questionInput(page, "thinking");
			await mcInput.tap();

			const submitBtn = page.getByRole("button", { name: /Submit answer/i });
			const clearance = await assertKeyboardClearance(page, submitBtn, 360);
			expect(clearance.visualViewportHeight).toBe(1133 - 360);

			const restoreKb = await simulateOnscreenKeyboard(page, 360);
			try {
				await assertElementUnoccluded(page, submitBtn);
				await assertElementUnoccluded(page, mcInput);
				await expect(dock.locator("img").first()).toBeVisible();
				await assertNoHorizontalOverflow(page);
			} finally {
				await restoreKb();
			}
		} finally {
			await context.close();
			await stack.cleanup();
		}
	});

	test("T2-F11-02: Narrow Split-View (375x1024) sidebar drawer open/select/dismiss", async ({ browser }) => {
		const stack = await bootStack();
		const context = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-SPLIT-1"]));
		const page = await context.newPage();
		try {
			await loginBrowser(page, stack.baseUrl);
			await page.goto(`${stack.baseUrl}/chat/chat_synth_teach_01`);
			await assertNoHorizontalOverflow(page);

			const closeBtn = page.getByRole("button", { name: /Close sidebar/i });
			if (await closeBtn.isVisible().catch(() => false)) {
				await closeBtn.tap();
			}
			await assertClosedSidebarNotOverlapping(page);

			const openBtn = page.getByRole("button", { name: /Open sidebar/i });
			await expect(openBtn).toBeVisible();
			await openBtn.tap();
			await expect(page.getByTestId("new-session")).toBeVisible();
			await assertNoHorizontalOverflow(page);

			await page.getByText("Graph BFS/DFS Traversal Practice").first().tap();
			await expect(page).toHaveURL(/\/chat\/chat_synth_prac_01/);
			await assertClosedSidebarNotOverlapping(page);
			await assertNoHorizontalOverflow(page);
		} finally {
			await context.close();
			await stack.cleanup();
		}
	});

	test("T2-F11-03: Orientation flip (820x1180 -> 1180x820) while Drawing Pad is open", async ({ browser }) => {
		const stack = await bootStack();
		const context = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-MD-PORT"]));
		const page = await context.newPage();
		try {
			await loginBrowser(page, stack.baseUrl);
			await page.goto(`${stack.baseUrl}/chat/chat_synth_teach_01`);

			const canvas = await openDrawingPad(page);
			await assertCanvasTouchActionNone(canvas);
			await drawCanvasStroke(page, canvas, {
				pointerType: "pen",
				points: [[0.2, 0.3], [0.8, 0.7]],
			});
			const portraitBox = await canvas.boundingBox();
			const portraitSnap = await getCanvasSnapshot(canvas);
			expect(portraitSnap.buffer.byteLength).toBeGreaterThan(0);

			await applyViewport(page, "VP-MD-LAND");
			await expect(canvas).toBeVisible();
			const landscapeBox = await canvas.boundingBox();
			expect(landscapeBox.width).toBeGreaterThan(portraitBox.width);

			const landscapeSnap = await getCanvasSnapshot(canvas);
			expect(landscapeSnap.dataUrl.length).toBeGreaterThan(100);
			await assertNoHorizontalOverflow(page);
			await assertElementsInViewport(page, [
				"[data-plugin-session-surface] canvas.drawing-pad-ink",
			]);
		} finally {
			await context.close();
			await stack.cleanup();
		}
	});

	test("T2-F11-04: Long code/math prose & wide table contained at 375x1024", async ({ browser }) => {
		const stack = await bootStack();
		const context = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-SPLIT-1"]));
		const page = await context.newPage();
		try {
			const wideChatId = "chat_synth_wide_content";
			const wideEq = "x_0=" + "v_0*cos(theta_0)*t+".repeat(12) + "end";
			const wideTable = [
				"| Step | Time | Vx | Vy | X | Y | Speed | Energy |",
				"|---|---|---|---|---|---|---|---|",
				"| 1 | 0.1s | 12.500 | 9.810 | 1.250 | 0.932 | 15.890 | 126.245 |",
			].join("\n");

			fs.writeFileSync(
				path.join(stack.ctrl.dataDir, "chats", `${wideChatId}.json`),
				JSON.stringify({
					id: wideChatId,
					title: "Wide Equation & Table",
					createdAt: "2026-11-18T10:00:00.000Z",
					updatedAt: "2026-11-18T10:05:00.000Z",
					version: 2,
					settings: { model: { provider: "custom", id: "gpt-test-1" }, thinkingLevel: "low" },
					messages: [
						{ id: "m1", role: "user", content: "Show wide trajectory table", timestamp: 1794301200000 },
						{
							id: "m2",
							role: "assistant",
							content: [{ type: "text", text: `Equation:\n\n\`${wideEq}\`\n\n${wideTable}` }],
							api: "openai-completions",
							provider: "custom",
							model: "gpt-test-1",
							stopReason: "stop",
							timestamp: 1794301205000,
						},
					],
				}),
				"utf8",
			);

			await loginBrowser(page, stack.baseUrl);
			await page.goto(`${stack.baseUrl}/chat/${wideChatId}`);
			await expect(page.getByText(/Wide Equation|Energy/i).first()).toBeVisible();
			await assertScrollableContainerContained(page, "main");
			await assertNoHorizontalOverflow(page);
		} finally {
			await context.close();
			await stack.cleanup();
		}
	});

	test("T2-F11-05: Collapsed QuestionDock / PracticeDock scroll preserves draft", async ({ browser }) => {
		const stack = await bootStack({ mockOptions: { chunkDelayMs: 5 } });
		const context = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-MD-PORT"]));
		const page = await context.newPage();
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			const chat = await createChatSession(stack.baseUrl, cookie, { title: "Scroll Collapse Draft" });

			// Add long transcript history so main scroll container scrolls > 120px
			await loginBrowser(page, stack.baseUrl);
			await page.goto(`${stack.baseUrl}/chat/${chat.id}`);
			const composer = composerInput(page);
			await composer.fill("[STREAM_LONG] populate transcript for scroll test");
			await page.getByRole("button", { name: "Send" }).click();
			await expect(page.getByText("Chunk 25/25:")).toBeVisible({ timeout: 20_000 });

			await composer.fill("[TRIGGER_MC]");
			await page.getByRole("button", { name: "Send" }).click();
			const dock = page.getByTestId("question-dock");
			await expect(dock).toBeVisible({ timeout: 15_000 });

			await page.getByRole("radio").nth(1).click();
			const mcInput = questionInput(page, "thinking");
			await mcInput.fill("Draft retained across collapse scroll");

			// Scroll transcript upward > 120px and back down
			await page.evaluate(() => {
				const scrollers = Array.from(document.querySelectorAll("main, [data-radix-scroll-area-viewport], div"))
					.filter((el) => el.scrollHeight > el.clientHeight + 120);
				for (const sc of scrollers) {
					sc.scrollTop = 0;
					sc.dispatchEvent(new Event("scroll", { bubbles: true }));
				}
			});
			await page.evaluate(() => {
				const scrollers = Array.from(document.querySelectorAll("main, [data-radix-scroll-area-viewport], div"))
					.filter((el) => el.scrollHeight > el.clientHeight + 120);
				for (const sc of scrollers) {
					sc.scrollTop = sc.scrollHeight;
					sc.dispatchEvent(new Event("scroll", { bubbles: true }));
				}
			});

			const bar = page.getByTestId("question-dock-bar");
			if (await bar.isVisible().catch(() => false)) {
				await bar.click();
			}
			await expect(page.getByRole("radio").nth(1)).toHaveAttribute("aria-checked", "true");
			await expect(mcInput).toContainText("Draft retained across collapse scroll");
		} finally {
			await context.close();
			await stack.cleanup();
		}
	});
});

test.describe("Tier 2 — F12: Extreme Split-View, Short Landscape, Touch Targets & Manual Checklist", () => {
	test("T2-F12-01: Sub-375px extreme Split-View (320x1024) WebKit check", async ({ browser }) => {
		const stack = await bootStack();
		const context = await browser.newContext(viewportContextOptions(EXTREME_SPLIT_VIEWPORT));
		const page = await context.newPage();
		try {
			await loginBrowser(page, stack.baseUrl);
			await page.goto(`${stack.baseUrl}/chat/chat_synth_teach_01`);
			await assertNoHorizontalOverflow(page);
			await assertElementsInViewport(page, ['[data-testid="composer"]', '[data-testid="stats-model"]']);

			const canvas = await openDrawingPad(page);
			await drawCanvasStroke(page, canvas, { pointerType: "pen", points: [[0.2, 0.3], [0.8, 0.7]] });
			await assertNoHorizontalOverflow(page);
			await assertElementsInViewport(page, ["[data-plugin-session-surface] canvas.drawing-pad-ink"]);
			await closeDrawingPad(page);
		} finally {
			await context.close();
			await stack.cleanup();
		}
	});

	test("T2-F12-02: Model Picker search & internal scroll on short landscape (1133x744)", async ({ browser }) => {
		const stack = await bootStack();
		const context = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-SM-LAND"]));
		const page = await context.newPage();
		try {
			await loginBrowser(page, stack.baseUrl);
			await page.goto(`${stack.baseUrl}/chat/chat_synth_teach_01`);

			await page.getByTestId("stats-model").tap();
			const menu = page.getByTestId("model-menu");
			await expect(menu).toBeVisible();
			await assertPopoversInViewport(page);

			const search = page.getByTestId("model-search");
			await expect(search).toBeVisible();
			await search.fill("gpt-test");
			await expect(menu.getByTestId("model-option-gpt-test-1")).toBeVisible();
			await assertPopoversInViewport(page);

			const menuBox = await menu.boundingBox();
			expect(menuBox.y).toBeGreaterThanOrEqual(0);
			expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(744 + 1);
		} finally {
			await context.close();
			await stack.cleanup();
		}
	});

	test("T2-F12-03: Drawing Pad collapsible Question on short landscape (1133x744)", async ({ browser }) => {
		const stack = await bootStack({ mockOptions: { chunkDelayMs: 5 } });
		const context = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-SM-LAND"]));
		const page = await context.newPage();
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			const chat = await createChatSession(stack.baseUrl, cookie, { title: "Short Landscape Question Bar" });

			await loginBrowser(page, stack.baseUrl);
			await page.goto(`${stack.baseUrl}/chat/${chat.id}`);
			await composerInput(page).fill("[TRIGGER_FREE]");
			await page.getByRole("button", { name: "Send" }).click();
			await expect(page.getByTestId("question-dock")).toBeVisible({ timeout: 15_000 });

			const canvas = await openDrawingPad(page);
			await toggleQuestionContext(page);
			await expect(page.locator(".drawing-pad-question-drawer").getByText(/horizontal and vertical components/i)).toBeVisible();
			await assertNoHorizontalOverflow(page);

			await toggleQuestionContext(page);
			await assertElementUnoccluded(page, canvas);
			await drawCanvasStroke(page, canvas, { pointerType: "pen", points: [[0.2, 0.5], [0.8, 0.5]] });
		} finally {
			await context.close();
			await stack.cleanup();
		}
	});

	test("T2-F12-04: Rapid sequential orientation toggles (3x)", async ({ browser }) => {
		const stack = await bootStack({ mockOptions: { chunkDelayMs: 5 } });
		const context = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-SM-PORT"]));
		const page = await context.newPage();
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			const chat = await createChatSession(stack.baseUrl, cookie, { title: "Rapid Rotation 3x" });

			await loginBrowser(page, stack.baseUrl);
			await page.goto(`${stack.baseUrl}/chat/${chat.id}`);
			await composerInput(page).fill("[TRIGGER_MC]");
			await page.getByRole("button", { name: "Send" }).click();
			await expect(page.getByTestId("question-dock")).toBeVisible({ timeout: 15_000 });

			await page.getByRole("radio").nth(1).click();
			const mcInput = questionInput(page, "thinking");
			await mcInput.fill("Rapid orientation draft");

			const canvas = await openDrawingPad(page);
			await drawCanvasStroke(page, canvas, { pointerType: "pen", points: [[0.25, 0.3], [0.75, 0.7]] });
			const snap = await getCanvasSnapshot(canvas);
			await closeDrawingPad(page);

			for (let i = 0; i < 3; i++) {
				await applyViewport(page, "VP-SM-LAND");
				await assertNoHorizontalOverflow(page);
				await applyViewport(page, "VP-SM-PORT");
				await assertNoHorizontalOverflow(page);
			}

			await expect(page.getByRole("radio").nth(1)).toHaveAttribute("aria-checked", "true");
			await expect(mcInput).toContainText("Rapid orientation draft");

			const reopenedCanvas = await openDrawingPad(page);
			const reopenedSnap = await getCanvasSnapshot(reopenedCanvas);
			expect(reopenedSnap.dataUrl).toBe(snap.dataUrl);
		} finally {
			await context.close();
			await stack.cleanup();
		}
	});

	test("T2-F12-05: Touch-target >=44x44 CSS px audit across primary controls (820x1180)", async ({ browser }) => {
		const stack = await bootStack({ mockOptions: { chunkDelayMs: 5 } });
		const context = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-MD-PORT"]));
		const page = await context.newPage();
		try {
			const { cookie } = await loginApi(stack.baseUrl);
			const chat = await createChatSession(stack.baseUrl, cookie, { title: "Touch Target Audit" });

			await loginBrowser(page, stack.baseUrl);
			await page.goto(`${stack.baseUrl}/chat/${chat.id}`);
			const drawAction = '[data-plugin-action="drawing-pad/draw"]';
			await expect(page.locator(drawAction)).toBeVisible();
			await assertTouchTargets(page, [
				'[aria-label="Open sidebar"]',
				'[data-testid="stats-model"]',
				'[aria-label="Send"]',
				'[aria-label="Attach files"]',
				drawAction,
			]);

			await composerInput(page).fill("[TRIGGER_MC]");
			await page.getByRole("button", { name: "Send" }).click();
			const dock = page.getByTestId("question-dock");
			const revealSelector = '[data-testid="question-dock-bar"], [data-testid="teach-check-reveal"]';
			const reveal = page.locator(revealSelector);
			const firstOption = dock.getByRole("radio").first();
			await expect(firstOption.or(reveal).first()).toBeVisible({ timeout: 15_000 });
			if (await reveal.isVisible()) {
				await assertTouchTargets(page, [revealSelector]);
				await reveal.click();
			}
			await firstOption.click();
			await expect(dock.getByRole("button", { name: "Submit answer" })).toBeEnabled();
			await assertTouchTargets(page, ['[data-testid="question-dock"] button:enabled']);
		} finally {
			await context.close();
			await stack.cleanup();
		}
	});

	test("T2-F12-06: Breakpoint transition (507x1180 -> 1024x1366 -> 1440x900) & Manual Checklist alignment", async ({
		browser,
	}, testInfo) => {
		const checklistPath = path.join(resolveRepoDir(), "tests", "e2e", "MANUAL_IPAD_AND_WINDOWS_CHECKLIST.md");
		expect(fs.existsSync(checklistPath)).toBe(true);
		const checklist = fs.readFileSync(checklistPath, "utf8");

		// Validate all 8 iPad CSS-px presets + desktop reference + hardware/VM/LXC sections
		for (const key of IPAD_VIEWPORT_KEYS) {
			const vp = VIEWPORT_MATRIX[key];
			expect(checklist).toContain(key);
			expect(checklist).toMatch(new RegExp(`${vp.width}\\s*[x×]\\s*${vp.height}`));
		}
		expect(checklist).toMatch(/1440\s*[x×]\s*900/);
		expect(checklist).toMatch(/Apple Pencil/i);
		expect(checklist).toMatch(/Windows VM/i);
		expect(checklist).toMatch(/LXC/i);
		expect(checklist).not.toMatch(/AppData\\Roaming|C:\\Users\\(?!Synth)/i);

		await testInfo.attach("viewport-summary", {
			body: Buffer.from(`${formatViewportSummary(ALL_VIEWPORT_KEYS)}\n`, "utf8"),
			contentType: "text/plain",
		});

		const stack = await bootStack();
		const context = await browser.newContext(viewportContextOptions(VIEWPORT_MATRIX["VP-SPLIT-2"]));
		const page = await context.newPage();
		try {
			await loginBrowser(page, stack.baseUrl);
			await page.goto(`${stack.baseUrl}/chat/chat_synth_teach_01`);

			const composer = composerInput(page);
			await composer.fill("Breakpoint state check draft");
			await assertResponsiveShell(page, {
				inViewportSelectors: ['[data-testid="composer"]', '[data-testid="stats-model"]'],
			});

			for (const targetKey of ["VP-LG-PORT", "VP-DESK-REF"]) {
				await applyViewport(page, targetKey);
				await assertResponsiveShell(page, {
					inViewportSelectors: ['[data-testid="composer"]', '[data-testid="stats-model"]'],
				});
				await expect(composer).toContainText("Breakpoint state check draft");
				await expect(page.getByText(/trajectory forms a parabola/i)).toBeVisible();
			}
		} finally {
			await context.close();
			await stack.cleanup();
		}
	});
});
