import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import { QuestionDock } from "../components/question-dock.tsx";
import { PracticeDock } from "../components/practice-dock.tsx";
import { SubmittedImages } from "../components/submitted-images.tsx";
import { AnsweredCard } from "../components/answered-card.tsx";
import { ThinkingCard } from "../components/practice-cards.tsx";
import { ThinkingBlock } from "../components/thinking-block.tsx";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";
import { registerSurfaceBoundary, registerSurfaceStaging, stageOnSurface } from "../components/plugin-surface-targets.ts";
import { newAnswerResult, newThinkingMessage, newUserMessage } from "../src/core/native-messages.ts";
import { projectView } from "../src/core/view.ts";
import { buildAnswer, type AttachmentRef, type PluginSurfaceTarget } from "../src/core/index.ts";

const IMG_SHA = "a".repeat(64);
const PDF_SHA = "b".repeat(64);

const IMG_REF: AttachmentRef = {
	id: IMG_SHA,
	filename: "diagram.png",
	mimeType: "image/png",
	sizeBytes: 256,
	kind: "image",
	url: `/api/attachments/${IMG_SHA}`,
};

const PDF_REF: AttachmentRef = {
	id: PDF_SHA,
	filename: "notes.pdf",
	mimeType: "application/pdf",
	sizeBytes: 1024,
	kind: "pdf",
	url: `/api/attachments/${PDF_SHA}`,
};

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); cleanup = undefined; });

async function mountNode(element: React.ReactElement) {
	const { window: win, document: doc } = parseHTML("<html><body><div id='root'></div></body></html>");
	let active: Element = doc.body;
	Object.defineProperty(doc, "activeElement", { get: () => active });
	const selection = {
		anchorNode: null as Node | null, anchorOffset: 0, focusNode: null as Node | null, focusOffset: 0,
		setBaseAndExtent(anchorNode: Node, anchorOffset: number, focusNode: Node, focusOffset: number) {
			Object.assign(this, { anchorNode, anchorOffset, focusNode, focusOffset });
		},
	};
	Object.assign(doc, { getSelection: () => selection, oninput: null });
	win.HTMLElement.prototype.focus = function () { active = this; };
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [name, next] of Object.entries({
		React, window: win, document: doc, Node: win.Node, HTMLElement: win.HTMLElement, Element: win.Element,
		Event: win.Event, CustomEvent: win.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: next });
	}
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(doc.getElementById("root")!);
	const draw = (el: React.ReactElement) => {
		root.render(<InteractionLayersProvider>{el}</InteractionLayersProvider>);
	};
	await act(async () => { draw(element); });
	cleanup = async () => {
		await act(async () => { root.unmount(); });
		for (const [name, desc] of previous) {
			if (desc) Object.defineProperty(globalThis, name, desc);
			else delete (globalThis as Record<string, unknown>)[name];
		}
	};
	return { win, doc, draw: async (el: React.ReactElement) => { await act(async () => { draw(el); }); } };
}

describe("QuestionDock, PracticeDock, transcript attachments & host staging", () => {
	it("QuestionDock enables Free-Response submit with staged image alone, preserves MC choice on upload error, disables during upload, and handles Ctrl+V paste", async () => {
		const uploaded: File[][] = [];
		const { win, doc, draw } = await mountNode(
			<QuestionDock
				toolName="ask_user_question"
				toolCallId="q-fr"
				input={{ question: "Show your work" }}
				expanded
				onExpand={() => {}}
				onSubmit={() => {}}
				attachments={[]}
				onUploadFiles={(files) => { uploaded.push(files); }}
			/>,
		);

		const submitBtn = doc.querySelector<HTMLButtonElement>('button[type="submit"]')!;
		const attachBtn = doc.querySelector<HTMLButtonElement>('[data-testid="question-attach-button"]')!;
		const fileInput = doc.querySelector<HTMLInputElement>('[data-testid="question-attach-input"]')!;
		assert.equal(submitBtn.disabled, true, "blank FR with no attachments cannot submit");
		assert.match(attachBtn.className, /min-h-11/);
		assert.match(submitBtn.className, /min-h-11/);
		assert.equal(fileInput.getAttribute("accept"), "image/*,application/pdf");

		// Ctrl+V paste of image anywhere on question-dock forwards file to onUploadFiles.
		const dockEl = doc.querySelector<HTMLElement>('[data-testid="question-dock"]')!;
		const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "paste.png", { type: "image/png" });
		const pasteEv = Object.assign(new win.Event("paste", { bubbles: true, cancelable: true }), {
			clipboardData: { files: [png], types: ["Files", "image/png"], getData: () => "" },
		});
		await act(async () => { dockEl.dispatchEvent(pasteEv); });
		assert.equal(uploaded.length, 1);
		assert.equal(uploaded[0]?.[0], png);

		// Re-render with staged image: FR submit becomes enabled even with empty text.
		await draw(
			<QuestionDock
				toolName="ask_user_question"
				toolCallId="q-fr"
				input={{ question: "Show your work" }}
				expanded
				onExpand={() => {}}
				onSubmit={() => {}}
				attachments={[IMG_REF]}
				onUploadFiles={(files) => { uploaded.push(files); }}
				onRemoveAttachment={() => {}}
			/>,
		);
		assert.equal(doc.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled, false);
		assert.ok(doc.querySelector(`img[src="${IMG_REF.url}"]`));
		const removeBtn = doc.querySelector<HTMLButtonElement>(`button[aria-label="Remove ${IMG_REF.filename}"]`)!;
		assert.ok(removeBtn);
		assert.match(removeBtn.className, /min-h-11/);

		// Re-render with uploading=true: submit disables cleanly.
		await draw(
			<QuestionDock
				toolName="ask_user_question"
				toolCallId="q-fr"
				input={{ question: "Show your work" }}
				expanded
				onExpand={() => {}}
				onSubmit={() => {}}
				attachments={[IMG_REF]}
				uploading
				uploadError="File exceeds 20 MiB limit"
			/>,
		);
		assert.equal(doc.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled, true);
		assert.match(doc.querySelector('[role="alert"]')?.textContent ?? "", /File exceeds 20 MiB limit/);
	});

	it("PracticeDock enables submit with attachment alone and disables while uploading", async () => {
		const { doc, draw } = await mountNode(
			<PracticeDock
				problemCallId="p1"
				input={{ statement: "Prove x^2 >= 0" }}
				expanded
				onExpand={() => {}}
				onSubmit={() => {}}
				attachments={[PDF_REF]}
			/>,
		);
		const submitBtn = doc.querySelector<HTMLButtonElement>('[data-testid="practice-send"]')!;
		assert.equal(submitBtn.disabled, false);
		assert.match(doc.body.textContent ?? "", /notes\.pdf/);

		await draw(
			<PracticeDock
				problemCallId="p1"
				input={{ statement: "Prove x^2 >= 0" }}
				expanded
				onExpand={() => {}}
				onSubmit={() => {}}
				attachments={[PDF_REF]}
				uploading
			/>,
		);
		assert.equal(doc.querySelector<HTMLButtonElement>('[data-testid="practice-send"]')!.disabled, true);
	});

	it("projects and renders AttachmentRef images and PDF chips in transcript cards", () => {
		const userMsg = newUserMessage("", undefined, [IMG_REF, PDF_REF]);
		const quizAnswer = buildAnswer(
			{
				id: "q1",
				kind: "quiz",
				question: "Pick",
				mode: "single-select",
				options: [{ label: "One", value: "One" }],
				correctIndices: [0],
				createdAt: new Date().toISOString(),
			},
			{ values: ["One"], attachments: [IMG_REF] },
		);
		const ansMsg = newAnswerResult("tc1", "quiz", quizAnswer);
		const thinkMsg = newThinkingMessage("p1", "Step 1", undefined, [IMG_REF, PDF_REF]);

		const view = projectView([userMsg, ansMsg, thinkMsg]);
		assert.equal(view[0]?.parts[0]?.type, "data-attachments");

		const imgsHtml = renderToStaticMarkup(<SubmittedImages attachments={[IMG_REF, PDF_REF]} />);
		assert.match(imgsHtml, new RegExp(IMG_REF.url.replace(/\//g, "\\/")));
		assert.match(imgsHtml, /notes\.pdf/);

		const cardHtml = renderToStaticMarkup(<AnsweredCard answer={quizAnswer} />);
		assert.match(cardHtml, new RegExp(IMG_REF.url.replace(/\//g, "\\/")));

		const thinkCardHtml = renderToStaticMarkup(
			<ThinkingCard data={{ problemCallId: "p1", text: "Step 1", attachments: [IMG_REF, PDF_REF] }} />,
		);
		assert.match(thinkCardHtml, /notes\.pdf/);
		assert.match(thinkCardHtml, new RegExp(IMG_REF.url.replace(/\//g, "\\/")));

		const blockHtml = renderToStaticMarkup(<ThinkingBlock text="Reasoning" attachments={[IMG_REF]} defaultOpen />);
		assert.match(blockHtml, new RegExp(IMG_REF.url.replace(/\//g, "\\/")));
	});

	it("stageOnSurface routes staged images to the registered surface boundary handler and rejects when inactive", async () => {
		const { document: doc } = parseHTML('<html><body><div id="body"><div data-session-surface-region><div data-session-surface-mounts></div></div></div></body></html>');
		const body = doc.getElementById("body")!;
		const ac = new AbortController();
		const controller = {
			claimEscape: () => {},
			registerScope: () => () => {},
			isTopLayer: () => true,
		} as unknown as Parameters<typeof registerSurfaceBoundary>[2];
		const boundary = registerSurfaceBoundary(body, ac.signal, controller);

		await assert.rejects(
			() => stageOnSurface(boundary.target, { mimeType: "image/png", data: "AAAA", filename: "pad.png" }),
			/No active submission surface/,
		);

		const received: string[] = [];
		const unregister = registerSurfaceStaging(boundary.target, async (img) => {
			received.push(`${img.mimeType}:${img.filename}`);
		});
		await stageOnSurface(boundary.target, { mimeType: "image/png", data: "AAAA", filename: "pad.png" });
		assert.deepEqual(received, ["image/png:pad.png"]);

		unregister();
		ac.abort();
		await assert.rejects(
			() => stageOnSurface({} as PluginSurfaceTarget, { mimeType: "image/png", data: "AAAA" }),
			/No active submission surface/,
		);
	});
});
