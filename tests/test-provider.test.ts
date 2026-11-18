import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { normalizeContext } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { configureTestCustomProvider, startTestProvider } from "./helpers/test-provider.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SYNTHETIC_PROFILE = path.join(HERE, "fixtures", "synthetic-profile");

// Set LH_DATA_DIR before importing any config-loading server/store modules.
const SYNTH_TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-synth-profile-"));
fs.cpSync(SYNTHETIC_PROFILE, SYNTH_TMP, { recursive: true });
const PREV_DATA_DIR = process.env.LH_DATA_DIR;
process.env.LH_DATA_DIR = SYNTH_TMP;

const { storeAttachment } = await import("../src/server/attachments.ts");
const { buildOpenAiCompatibleProvider, discoverModels } = await import("../src/server/custom-provider.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { graphStore } = await import("../src/store/graph.ts");
const { settingsStore } = await import("../src/store/settings.ts");
const { readRenderSettings } = await import("../src/store/render-settings.ts");
const { getGraph } = await import("../src/core/graph.ts");
const { toLlmMessages } = await import("../src/core/native-messages.ts");
const { phaseAt3Lh } = await import("../src/core/phases.ts");

const PNG_1X1_B64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";

const extraTempDirs: string[] = [];
function mkTempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	extraTempDirs.push(dir);
	return dir;
}

after(() => {
	if (PREV_DATA_DIR === undefined) delete process.env.LH_DATA_DIR;
	else process.env.LH_DATA_DIR = PREV_DATA_DIR;
	fs.rmSync(SYNTH_TMP, { recursive: true, force: true });
	while (extraTempDirs.length > 0) {
		fs.rmSync(extraTempDirs.pop()!, { recursive: true, force: true });
	}
});

describe("Isolated test provider (F2)", () => {
	it("discovers models, streams text/reasoning/tool calls, captures vision image_url, and injects /v1/models errors", async () => {
		const providerServer = await startTestProvider();
		try {
			const discovered = await discoverModels(providerServer.baseUrl);
			assert.equal(discovered.ok, true);
			if (!discovered.ok) return;
			assert.equal(discovered.models[0]?.id, "test-model-vision");
			assert.equal(discovered.models[0]?.image, true);
			assert.equal(discovered.models[0]?.reasoning, true);
			assert.equal(discovered.models[0]?.context, 128_000);

			// Inject transient /v1/models 503 for 1 call, then recover
			providerServer.setModelsError({ status: 503, count: 1 });
			const failed = await discoverModels(providerServer.baseUrl);
			assert.equal(failed.ok, false);
			if (!failed.ok) assert.equal(failed.status, 503);

			const recovered = await discoverModels(providerServer.baseUrl);
			assert.equal(recovered.ok, true);

			// Stream chat completion with image content and tool call
			const provider = buildOpenAiCompatibleProvider({
				baseUrl: providerServer.baseUrl,
				models: discovered.models,
			});
			const model = provider.getModels()[0]!;
			providerServer.enqueue({
				reasoning: "Inspecting the triangle diagram.",
				chunks: ["The angles ", "sum to 180 degrees."],
				toolCalls: [{ name: "check_sum", arguments: { sum: 180 } }],
			});

			const api = openAICompletionsApi();
			const stream = api.streamSimple!(
				model,
				normalizeContext({
					systemPrompt: "You are a geometry tutor.",
					messages: [
						{
							role: "user",
							content: [
								{ type: "text", text: "What do the angles in this diagram sum to?" },
								{ type: "image", data: PNG_1X1_B64, mimeType: "image/png" },
							],
							timestamp: Date.now(),
						},
					],
				}),
				{ apiKey: "not-needed" },
			);
			const result = await stream.result();
			assert.equal(result.stopReason, "toolUse", result.errorMessage);
			assert(result.content.some((b) => b.type === "text" && b.text.includes("180 degrees")));
			assert(result.content.some((b) => b.type === "toolCall" && b.name === "check_sum"));

			assert.equal(providerServer.requests.length, 1);
			const captured = providerServer.requests[0]!;
			assert.equal(captured.endpoint, "/v1/chat/completions");
			assert.equal(captured.images.length, 1);
			assert.equal(captured.images[0]!.mimeType, "image/png");
			assert.equal(captured.images[0]!.base64Bytes, Buffer.from(PNG_1X1_B64, "base64").byteLength);

			// Verify hold gate for M3 live handoff tests
			let releaseGate!: () => void;
			const gate = new Promise<void>((resolve) => {
				releaseGate = resolve;
			});
			providerServer.enqueue({ gate, text: "Held response completed." });
			const heldPromise = api.streamSimple!(
				model,
				normalizeContext({
					messages: [{ role: "user", content: [{ type: "text", text: "Hold test" }], timestamp: Date.now() }],
				}),
				{ apiKey: "not-needed" },
			).result();
			await new Promise((r) => setTimeout(r, 30));
			releaseGate();
			const heldResult = await heldPromise;
			assert(heldResult.content.some((b) => b.type === "text" && b.text.includes("Held response completed.")));

			// Verify /v1/responses endpoint (ChatGPT / OpenAI Responses SSE format)
			providerServer.enqueue({ text: "Responses API reply." });
			const resp = await fetch(`${providerServer.baseUrl}/responses`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
				body: JSON.stringify({
					model: "gpt-5",
					stream: true,
					input: [
						{
							role: "user",
							content: [
								{ type: "input_text", text: "Hello" },
								{ type: "input_image", image_url: `data:image/png;base64,${PNG_1X1_B64}` },
							],
						},
					],
				}),
			});
			assert.equal(resp.status, 200);
			const sseText = await resp.text();
			assert(sseText.includes("response.output_text.delta"));
			assert(sseText.includes("response.completed"));
			assert.equal(providerServer.requests.at(-1)?.images[0]?.mimeType, "image/png");
		} finally {
			await providerServer.close();
		}
	});

	it("writes test custom provider settings cleanly with configureTestCustomProvider", () => {
		const dataDir = mkTempDir("lh-provider-cfg-");
		configureTestCustomProvider(dataDir, "http://127.0.0.1:4321/v1");
		const written = JSON.parse(fs.readFileSync(path.join(dataDir, "settings.json"), "utf8"));
		assert.equal(written.customProvider.baseUrl, "http://127.0.0.1:4321/v1");
		assert.equal(written.models.strong.model.provider, "custom");
	});
});

describe("Synthetic profile fixtures (F2)", () => {
	it("loads cleanly through production chatStore, graphStore, settingsStore, and toLlmMessages without personal data", () => {
		const settings = settingsStore.readSettings();
		assert(settings);
		assert.equal(settings.models?.strong?.model?.provider, "custom");

		const chats = chatStore.listChats();
		assert.equal(chats.length, 2);
		for (const summary of chats) {
			const chat = chatStore.getChat(summary.id);
			assert(chat);
			assert.equal(typeof phaseAt3Lh(chat.messages), "string");
			const wire = toLlmMessages(chat.messages);
			assert(wire.length > 0);
		}

		const graph = getGraph(graphStore);
		assert.equal(graph.nodes.length, 3);
		assert.equal(graph.chains.length, 1);
		const render = readRenderSettings();
		assert(render);
		assert.equal(render.sizeUnits, "world");

		// Sample attachments ingest cleanly into the shared attachment store
		const pngRes = storeAttachment({
			bytes: fs.readFileSync(path.join(SYNTHETIC_PROFILE, "sample-attachments", "triangle.png")),
			filename: "triangle.png",
			mimeType: "image/png",
			dataDir: SYNTH_TMP,
		});
		assert.equal(pngRes.ref.kind, "image");
		const pdfRes = storeAttachment({
			bytes: fs.readFileSync(path.join(SYNTHETIC_PROFILE, "sample-attachments", "triangle-notes.pdf")),
			filename: "triangle-notes.pdf",
			mimeType: "application/pdf",
			dataDir: SYNTH_TMP,
		});
		assert.equal(pdfRes.ref.kind, "pdf");
	});
});
