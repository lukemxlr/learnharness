import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import { setFileAccessPolicy } from "../src/agent/tools/file-access.ts";
import { storeAttachment } from "../src/server/attachments.ts";
import {
	clearLiveTurnAttachments,
	hydrateMessagesSync,
	prepareSteerAttachments,
	resolveTurnAttachments,
	setLiveTurnAttachments,
	type ResolvedAttachmentMap,
} from "../src/server/attachment-delivery.ts";
import { ChatInputError, parseChatInput, parseUserSteerInput } from "../src/core/input-events.ts";
import { newAnswerResult, newThinkingMessage, newUserMessage, newUserSteer, type LhMessage } from "../src/core/native-messages.ts";
import { buildAnswer, type QuestionData } from "../src/core/question-core.ts";
import { tinyPdf } from "./helpers/tiny-pdf.ts";

// Valid 1x1 PNG bytes
const PNG_1X1 = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
	"base64",
);

const tempDirs: string[] = [];
function mkTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-att-delivery-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
	}
});

function fakeEngine(input: Array<"text" | "image">): Pick<PiEngine, "model"> {
	return {
		model: {
			id: "test-model",
			name: "Test Model",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://example.invalid",
			reasoning: false,
			input,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 4096,
		} as unknown as Model<"openai-responses">,
	};
}

describe("server attachment delivery", () => {
	it("delivers small PNG ImageContent with exact verbatim SHA-256 preserved", async () => {
		const dir = mkTempDir();
		const stored = storeAttachment({ bytes: PNG_1X1, filename: "diagram.png", mimeType: "image/png", dataDir: dir });
		const msg = newUserMessage("Explain this diagram", undefined, [stored.ref]);
		const engine = fakeEngine(["text", "image"]);

		const map = await resolveTurnAttachments(
			[msg],
			{ type: "text", text: "Explain this diagram", attachments: [stored.ref] },
			engine,
			{ dataDir: dir },
		);
		const hydrated = hydrateMessagesSync([msg], map);
		assert.equal(hydrated.length, 1);
		const content = (hydrated[0] as { content: unknown }).content as Array<{ type: string; data?: string; mimeType?: string; text?: string }>;
		assert.equal(content[0]?.type, "text");
		assert.equal(content[0]?.text, "Explain this diagram");
		assert.equal(content[1]?.type, "image");
		assert.equal(content[1]?.mimeType, "image/png");
		const deliveredBytes = Buffer.from(content[1]!.data!, "base64");
		const expectedSha = crypto.createHash("sha256").update(PNG_1X1).digest("hex");
		const actualSha = crypto.createHash("sha256").update(deliveredBytes).digest("hex");
		assert.equal(actualSha, expectedSha, "small valid PNG must not be re-encoded so SHA-256 stays verbatim");
	});

	it("extracts PDF markdown independently of fileAccess, caches .extracted.json, and avoids re-extraction", async () => {
		const dir = mkTempDir();
		const pdfBytes = tinyPdf([{ runs: [{ text: "Eigenvalues and eigenvectors", x: 72, y: 720 }] }]);
		const stored = storeAttachment({ bytes: pdfBytes, filename: "linalg.pdf", mimeType: "application/pdf", dataDir: dir });
		const msg = newUserMessage("Summarize this PDF", undefined, [stored.ref]);
		const engine = fakeEngine(["text"]);

		let convertCalls = 0;
		const deps = {
			dataDir: dir,
			convertPdf: async () => {
				convertCalls++;
				return {
					kind: "converted" as const,
					pages: [{ number: 1, kind: "text" as const, markdown: "## Linear Algebra\n\nEigenvalues and eigenvectors" }],
				};
			},
		};

		const map1 = await resolveTurnAttachments([msg], { type: "text", text: "Summarize this PDF", attachments: [stored.ref] }, engine, deps);
		assert.equal(convertCalls, 1);
		const hydrated1 = hydrateMessagesSync([msg], map1);
		const blocks1 = (hydrated1[0] as { content: Array<{ type: string; text?: string }> }).content;
		assert.ok(blocks1.some((b) => b.type === "text" && b.text?.includes("Eigenvalues and eigenvectors")));

		const cacheFile = path.join(dir, "attachments", stored.ref.id, `${stored.ref.id}.extracted.json`);
		assert.ok(fs.existsSync(cacheFile), "PDF extraction cache file must exist");

		// Second resolution hits cache instead of re-converting.
		const map2 = await resolveTurnAttachments([msg], null, engine, deps);
		assert.equal(convertCalls, 1);
		const hydrated2 = hydrateMessagesSync([msg], map2);
		const blocks2 = (hydrated2[0] as { content: Array<{ type: string; text?: string }> }).content;
		assert.ok(blocks2.some((b) => b.type === "text" && b.text?.includes("## Linear Algebra")));
	});

	it("extracts real PDF text via unmocked convertPdf even when fileAccess is restricted", async () => {
		const dir = mkTempDir();
		const pdfBytes = tinyPdf([{ runs: [{ text: "Spectral theorem over finite spaces", x: 72, y: 720 }] }]);
		const stored = storeAttachment({ bytes: pdfBytes, filename: "spectral.pdf", mimeType: "application/pdf", dataDir: dir });
		const msg = newUserMessage("Explain this theorem", undefined, [stored.ref]);
		const engine = fakeEngine(["text"]);

		setFileAccessPolicy(() => ({ restricted: true, folders: [] }));
		try {
			const map = await resolveTurnAttachments(
				[msg],
				{ type: "text", text: "Explain this theorem", attachments: [stored.ref] },
				engine,
				{ dataDir: dir },
			);
			const hydrated = hydrateMessagesSync([msg], map);
			const content = (hydrated[0] as { content: Array<{ type: string; text?: string }> }).content;
			assert.ok(
				content.some((b) => b.type === "text" && b.text?.includes("Spectral theorem over finite spaces")),
				"unmocked convertPdf must deliver extracted PDF text to the model",
			);
		} finally {
			setFileAccessPolicy(() => ({ restricted: false, folders: [] }));
		}
	});

	it("handles scanned image-only PDFs for vision models and explains cleanly to text-only models", async () => {
		const dir = mkTempDir();
		const pdfBytes = tinyPdf([{ image: true }]);
		const stored = storeAttachment({ bytes: pdfBytes, filename: "scan.pdf", mimeType: "application/pdf", dataDir: dir });
		const msg = newUserMessage("Check scan", undefined, [stored.ref]);

		let renderCalls = 0;
		const deps = {
			dataDir: dir,
			convertPdf: async () => ({
				kind: "converted" as const,
				pages: [{ number: 1, kind: "image-only" as const }],
			}),
			renderPdfPages: async () => {
				renderCalls++;
				return [{ page: 1, png: PNG_1X1 }];
			},
		};

		// Text-only model gets clear notice without crashing or rendering pages.
		const textMap = await resolveTurnAttachments([msg], { type: "text", text: "Check scan", attachments: [stored.ref] }, fakeEngine(["text"]), deps);
		assert.equal(renderCalls, 0);
		const textHydrated = hydrateMessagesSync([msg], textMap);
		const textContent = (textHydrated[0] as { content: Array<{ type: string; text?: string }> }).content;
		assert.ok(textContent.some((b) => b.type === "text" && b.text?.includes("does not support image input")));

		// Vision model renders pages and delivers ImageContent.
		const visionMap = await resolveTurnAttachments([msg], { type: "text", text: "Check scan", attachments: [stored.ref] }, fakeEngine(["text", "image"]), deps);
		assert.equal(renderCalls, 1);
		const visionHydrated = hydrateMessagesSync([msg], visionMap);
		const visionContent = (visionHydrated[0] as { content: Array<{ type: string; data?: string }> }).content;
		assert.ok(visionContent.some((b) => b.type === "image" && typeof b.data === "string" && b.data.length > 0));
	});

	it("fails cleanly with ChatInputError on corrupt %PDF- attachments and rejects image-only models cleanly", async () => {
		const dir = mkTempDir();
		const pdfBytes = tinyPdf([{ runs: [{ text: "broken", x: 72, y: 720 }] }]);
		const stored = storeAttachment({ bytes: pdfBytes, filename: "corrupt.pdf", mimeType: "application/pdf", dataDir: dir });
		await assert.rejects(
			() => resolveTurnAttachments([], { type: "text", text: "Read", attachments: [stored.ref] }, fakeEngine(["text", "image"]), {
				dataDir: dir,
				convertPdf: async () => {
					throw new Error("Invalid PDF structure");
				},
			}),
			(err: unknown) => err instanceof ChatInputError && /Could not read PDF/.test(err.message),
		);

		const imgStored = storeAttachment({ bytes: PNG_1X1, filename: "work.png", mimeType: "image/png", dataDir: dir });
		await assert.rejects(
			() => resolveTurnAttachments([], { type: "text", text: "See image", attachments: [imgStored.ref] }, fakeEngine(["text"]), { dataDir: dir }),
			(err: unknown) => err instanceof ChatInputError && /does not support images/.test(err.message),
		);
	});

	it("supports MC+image+thinking, FR image-only, practice thinking, and mid-turn steer attachments", async () => {
		const dir = mkTempDir();
		const imgStored = storeAttachment({ bytes: PNG_1X1, filename: "work.png", mimeType: "image/png", dataDir: dir });

		// 1) MC answer with option + justification + image attachment
		const mcQuestion: QuestionData = {
			id: "q-mc",
			kind: "quiz",
			question: "Which value?",
			options: [
				{ label: "A", value: "A" },
				{ label: "B", value: "B" },
			],
			correctIndices: [0],
			mode: "single-select",
			createdAt: new Date().toISOString(),
		};
		const answerData = buildAnswer(mcQuestion, { values: ["A"], thinking: "By symmetry", attachments: [imgStored.ref] });
		const parsedMc = parseChatInput({
			type: "answer",
			toolCallId: "tc-mc",
			occurrence: { messageId: "m1", contentIndex: 0, toolCallId: "tc-mc", toolName: "quiz" },
			answer: answerData,
		});
		assert.equal(parsedMc.type, "answer");
		assert.equal(parsedMc.answer.attachments?.[0]?.id, imgStored.ref.id);

		// 2) Free-Response image-only (blank text)
		const frQuestion: QuestionData = {
			id: "q-fr",
			kind: "ask",
			question: "Sketch the proof",
			mode: "text",
			options: [],
			createdAt: new Date().toISOString(),
		};
		const frAnswer = buildAnswer(frQuestion, { text: "", attachments: [imgStored.ref] });
		assert.equal(frAnswer.kind, "ask");
		assert.equal(frAnswer.attachments?.[0]?.id, imgStored.ref.id);

		// 3) User steer input with attachment only
		const steerInput = parseUserSteerInput({ type: "steer", id: "steer-1", text: "", attachments: [imgStored.ref] });
		assert.equal(steerInput.attachments?.[0]?.id, imgStored.ref.id);

		// 4) Multi-turn hydration across toolResult, practice-thinking, and live steer
		const engine = fakeEngine(["text", "image"]);
		const map: ResolvedAttachmentMap = new Map();
		setLiveTurnAttachments("chat-live", engine, map);
		const preparedSteer = await prepareSteerAttachments("chat-live", [imgStored.ref], engine, { dataDir: dir });
		assert.equal(preparedSteer?.[0]?.id, imgStored.ref.id);

		const messages: LhMessage[] = [
			newAnswerResult("tc-mc", "quiz", answerData),
			newThinkingMessage("prob-1", "My trace", undefined, [imgStored.ref]),
			newUserSteer("Look here too", "steer-1", undefined, preparedSteer),
		];
		const hydrated = hydrateMessagesSync(messages as unknown as Parameters<typeof hydrateMessagesSync>[0], map);
		clearLiveTurnAttachments("chat-live", map);

		const toolRes = hydrated[0] as { content: Array<{ type: string; text?: string; data?: string }> };
		assert.ok(toolRes.content.some((c) => c.type === "text" && c.text === "Answer images:"));
		assert.ok(toolRes.content.some((c) => c.type === "image" && typeof c.data === "string"));

		const thinkingMsg = hydrated[1] as { details: { images?: Array<{ type: string; data: string }> } };
		assert.equal(thinkingMsg.details.images?.length, 1);

		const steerMsg = hydrated[2] as { content: Array<{ type: string; data?: string }> };
		assert.ok(steerMsg.content.some((c) => c.type === "image"));
	});
});
