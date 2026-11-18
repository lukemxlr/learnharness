import * as fs from "node:fs";
import http from "node:http";
import type net from "node:net";
import * as path from "node:path";
import type { CustomModel } from "../../src/core/settings.ts";

export interface TestProviderModelSpec {
	id: string;
	name?: string;
	context_length?: number;
	max_output_tokens?: number;
	input_modalities?: string[];
	capabilities?: string[];
	supported_parameters?: string[];
	reasoning?: boolean;
	supported_reasoning_levels?: Array<string | { effort: string; description?: string }>;
	visibility?: "list" | "hide";
}

export interface CapturedImagePart {
	url: string;
	mimeType?: string;
	base64Bytes?: number;
}

export interface CapturedProviderRequest {
	endpoint: "/v1/chat/completions" | "/v1/responses";
	method: string;
	url: string;
	authorization: string | null;
	model: string | undefined;
	stream: boolean | undefined;
	messages: unknown;
	input: unknown;
	tools: unknown;
	reasoningEffort: unknown;
	images: CapturedImagePart[];
	rawBody: Record<string, unknown>;
}

export interface ScriptedToolCall {
	id?: string;
	name: string;
	arguments: string | Record<string, unknown>;
}

export interface ScriptedChatResponse {
	text?: string;
	chunks?: string[];
	reasoning?: string;
	toolCalls?: ScriptedToolCall[];
	gate?: Promise<void>;
	error?: { status: number; body?: unknown } | { midStreamAbort: true } | { responseFailed: { code?: string; message?: string } };
}

export interface ModelsErrorConfig {
	status: number | "network";
	count?: number;
	body?: unknown;
}

export interface TestProviderHandle {
	baseUrl: string;
	origin: string;
	requests: CapturedProviderRequest[];
	modelsRequests: Array<{ url: string; authorization: string | null }>;
	clearRequests(): void;
	setModels(models: TestProviderModelSpec[], format?: "openai" | "chatgpt"): void;
	setModelsError(error: ModelsErrorConfig | null): void;
	enqueue(response: ScriptedChatResponse): void;
	close(): Promise<void>;
}

function parseDataUrl(url: string): { mimeType?: string; base64Bytes?: number } {
	const match = /^data:([^;,]+);base64,(.+)$/i.exec(url);
	if (!match) return {};
	return {
		mimeType: match[1]!.toLowerCase(),
		base64Bytes: Buffer.from(match[2]!, "base64").byteLength,
	};
}

function extractImages(value: unknown, out: CapturedImagePart[] = []): CapturedImagePart[] {
	if (Array.isArray(value)) {
		for (const item of value) extractImages(item, out);
		return out;
	}
	if (!value || typeof value !== "object") return out;
	const obj = value as Record<string, unknown>;
	if (obj.type === "image_url" && obj.image_url && typeof obj.image_url === "object") {
		const url = (obj.image_url as { url?: unknown }).url;
		if (typeof url === "string") out.push({ url, ...parseDataUrl(url) });
	} else if (obj.type === "input_image" && typeof obj.image_url === "string") {
		out.push({ url: obj.image_url, ...parseDataUrl(obj.image_url) });
	}
	for (const val of Object.values(obj)) {
		if (typeof val === "object" && val !== null) extractImages(val, out);
	}
	return out;
}

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			try {
				const raw = Buffer.concat(chunks).toString("utf8");
				resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
			} catch (err) {
				reject(err);
			}
		});
		req.on("error", reject);
	});
}

export async function startTestProvider(initial?: {
	models?: TestProviderModelSpec[];
	modelsFormat?: "openai" | "chatgpt";
}): Promise<TestProviderHandle> {
	let models: TestProviderModelSpec[] = initial?.models ?? [
		{
			id: "test-model-vision",
			name: "Test Model Vision",
			context_length: 128_000,
			max_output_tokens: 8_192,
			input_modalities: ["text", "image"],
			capabilities: ["vision", "reasoning"],
			supported_parameters: ["reasoning", "reasoning_effort"],
			reasoning: true,
			supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }],
			visibility: "list",
		},
	];
	let modelsFormat: "openai" | "chatgpt" = initial?.modelsFormat ?? "openai";
	let modelsError: ModelsErrorConfig | null = null;
	let remainingModelsErrors = 0;

	const queue: ScriptedChatResponse[] = [];
	const requests: CapturedProviderRequest[] = [];
	const modelsRequests: Array<{ url: string; authorization: string | null }> = [];
	const sockets = new Set<net.Socket>();
	const activeCleanups = new Set<() => void>();

	const server = http.createServer(async (req, res) => {
		const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");

		if (req.method === "GET" && (reqUrl.pathname === "/v1/models" || reqUrl.pathname === "/models")) {
			modelsRequests.push({
				url: reqUrl.pathname + reqUrl.search,
				authorization: req.headers.authorization ?? null,
			});
			if (modelsError && (modelsError.count === undefined || remainingModelsErrors > 0)) {
				if (modelsError.count !== undefined) remainingModelsErrors--;
				if (modelsError.status === "network") {
					req.socket.destroy();
					return;
				}
				res.writeHead(modelsError.status, { "Content-Type": "application/json" });
				res.end(JSON.stringify(modelsError.body ?? { error: { message: `Injected ${modelsError.status}` } }));
				return;
			}
			const useChatGptShape = modelsFormat === "chatgpt" || (reqUrl.pathname === "/models" && initial?.modelsFormat === "chatgpt");
			if (useChatGptShape) {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						models: models.map((m) => ({
							slug: m.id,
							display_name: m.name ?? m.id,
							visibility: m.visibility ?? "list",
							...(m.context_length !== undefined ? { context_length: m.context_length } : {}),
							...(m.max_output_tokens !== undefined ? { max_output_tokens: m.max_output_tokens } : {}),
							...(m.input_modalities !== undefined ? { input_modalities: m.input_modalities } : {}),
							...(m.reasoning !== undefined ? { reasoning: m.reasoning } : {}),
							...(m.supported_reasoning_levels !== undefined ? { supported_reasoning_levels: m.supported_reasoning_levels } : {}),
						})),
					}),
				);
				return;
			}
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					object: "list",
					data: models.map((m) => ({
						id: m.id,
						object: "model",
						owned_by: "test-provider",
						...(m.context_length !== undefined ? { context_length: m.context_length } : {}),
						...(m.max_output_tokens !== undefined ? { max_output_tokens: m.max_output_tokens } : {}),
						...(m.input_modalities !== undefined ? { architecture: { input_modalities: m.input_modalities } } : {}),
						...(m.capabilities !== undefined ? { capabilities: m.capabilities } : {}),
						...(m.supported_parameters !== undefined ? { supported_parameters: m.supported_parameters } : {}),
						...(m.reasoning !== undefined ? { reasoning: m.reasoning } : {}),
					})),
				}),
			);
			return;
		}

		if (req.method === "POST" && (reqUrl.pathname === "/v1/chat/completions" || reqUrl.pathname === "/v1/responses")) {
			let body: Record<string, unknown>;
			try {
				body = await readJsonBody(req);
			} catch {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: { message: "Invalid JSON" } }));
				return;
			}

			const endpoint = reqUrl.pathname as "/v1/chat/completions" | "/v1/responses";
			const captured: CapturedProviderRequest = {
				endpoint,
				method: req.method,
				url: reqUrl.pathname + reqUrl.search,
				authorization: req.headers.authorization ?? null,
				model: typeof body.model === "string" ? body.model : undefined,
				stream: typeof body.stream === "boolean" ? body.stream : undefined,
				messages: body.messages,
				input: body.input,
				tools: body.tools,
				reasoningEffort: body.reasoning_effort ?? body.reasoning,
				images: extractImages(endpoint === "/v1/chat/completions" ? body.messages : body.input),
				rawBody: body,
			};
			requests.push(captured);

			const scripted = queue.shift() ?? { text: "Deterministic test response." };
			if (scripted.error && "status" in scripted.error) {
				res.writeHead(scripted.error.status, { "Content-Type": "application/json" });
				res.end(JSON.stringify(scripted.error.body ?? { error: { message: `Injected error ${scripted.error.status}` } }));
				return;
			}

			const modelId = captured.model ?? models[0]?.id ?? "test-model-vision";
			let closedByAbort = false;
			const onClose = () => {
				closedByAbort = true;
			};
			req.on("close", onClose);
			activeCleanups.add(() => req.socket.destroy());

			res.writeHead(200, {
				"Content-Type": "text/event-stream; charset=utf-8",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			});

			const sendSse = (payload: unknown) => {
				if (closedByAbort || res.writableEnded) return;
				res.write(`data: ${JSON.stringify(payload)}\n\n`);
			};

			if (endpoint === "/v1/chat/completions") {
				sendSse({
					id: "chatcmpl-test-1",
					object: "chat.completion.chunk",
					created: 1,
					model: modelId,
					choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
				});

				if (scripted.gate) {
					await Promise.race([
						scripted.gate,
						new Promise<void>((resolve) => req.once("close", resolve)),
					]);
				}
				if (closedByAbort) return;
				if (scripted.error && "midStreamAbort" in scripted.error) {
					req.socket.destroy();
					return;
				}
				if (scripted.reasoning) {
					sendSse({
						id: "chatcmpl-test-1",
						object: "chat.completion.chunk",
						created: 1,
						model: modelId,
						choices: [{ index: 0, delta: { reasoning_content: scripted.reasoning }, finish_reason: null }],
					});
				}
				const textChunks = scripted.chunks ?? (scripted.text !== undefined ? [scripted.text] : []);
				for (const chunk of textChunks) {
					sendSse({
						id: "chatcmpl-test-1",
						object: "chat.completion.chunk",
						created: 1,
						model: modelId,
						choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }],
					});
				}
				if (scripted.toolCalls && scripted.toolCalls.length > 0) {
					scripted.toolCalls.forEach((tc, index) => {
						const args = typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments);
						sendSse({
							id: "chatcmpl-test-1",
							object: "chat.completion.chunk",
							created: 1,
							model: modelId,
							choices: [
								{
									index: 0,
									delta: {
										tool_calls: [
											{
												index,
												id: tc.id ?? `call_test_${index + 1}`,
												type: "function",
												function: { name: tc.name, arguments: args },
											},
										],
									},
									finish_reason: null,
								},
							],
						});
					});
				}
				sendSse({
					id: "chatcmpl-test-1",
					object: "chat.completion.chunk",
					created: 1,
					model: modelId,
					choices: [
						{
							index: 0,
							delta: {},
							finish_reason: scripted.toolCalls && scripted.toolCalls.length > 0 ? "tool_calls" : "stop",
						},
					],
					usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
				});
				if (!closedByAbort && !res.writableEnded) {
					res.write("data: [DONE]\n\n");
					res.end();
				}
				return;
			}

			// /v1/responses SSE sequence
			sendSse({ type: "response.created", response: { id: "resp_test_1" } });
			if (scripted.gate) {
				await Promise.race([
					scripted.gate,
					new Promise<void>((resolve) => req.once("close", resolve)),
				]);
			}
			if (closedByAbort) return;
			if (scripted.error && "midStreamAbort" in scripted.error) {
				req.socket.destroy();
				return;
			}
			if (scripted.error && "responseFailed" in scripted.error) {
				sendSse({
					type: "error",
					code: scripted.error.responseFailed.code ?? "server_error",
					message: scripted.error.responseFailed.message ?? "Injected responses error",
				});
				res.end();
				return;
			}

			const outputItems: unknown[] = [];
			let outputIndex = 0;

			if (scripted.text !== undefined || scripted.chunks) {
				const fullText = scripted.chunks ? scripted.chunks.join("") : (scripted.text ?? "");
				const msgItem = {
					type: "message",
					id: "msg_test_1",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: fullText, annotations: [] }],
				};
				sendSse({ type: "response.output_item.added", output_index: outputIndex, item: { type: "message", id: "msg_test_1", role: "assistant", content: [] } });
				sendSse({ type: "response.content_part.added", output_index: outputIndex, content_index: 0, part: { type: "output_text", text: "" } });
				for (const delta of scripted.chunks ?? [fullText]) {
					sendSse({ type: "response.output_text.delta", output_index: outputIndex, content_index: 0, delta });
				}
				sendSse({ type: "response.content_part.done", output_index: outputIndex, content_index: 0, part: msgItem.content[0] });
				sendSse({ type: "response.output_item.done", output_index: outputIndex, item: msgItem });
				outputItems.push(msgItem);
				outputIndex++;
			}

			for (const [idx, tc] of (scripted.toolCalls ?? []).entries()) {
				const args = typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments);
				const callItem = {
					type: "function_call",
					id: `fc_test_${idx + 1}`,
					call_id: tc.id ?? `call_test_${idx + 1}`,
					name: tc.name,
					arguments: args,
					status: "completed",
				};
				sendSse({ type: "response.output_item.added", output_index: outputIndex, item: { ...callItem, arguments: "" } });
				sendSse({ type: "response.function_call_arguments.delta", output_index: outputIndex, item_id: callItem.id, delta: args });
				sendSse({ type: "response.output_item.done", output_index: outputIndex, item: callItem });
				outputItems.push(callItem);
				outputIndex++;
			}

			sendSse({
				type: "response.completed",
				response: {
					id: "resp_test_1",
					status: "completed",
					output: outputItems,
					usage: {
						input_tokens: 12,
						output_tokens: 8,
						total_tokens: 20,
						input_tokens_details: { cached_tokens: 0 },
						output_tokens_details: { reasoning_tokens: 0 },
					},
				},
			});
			if (!closedByAbort && !res.writableEnded) res.end();
			return;
		}

		res.writeHead(404, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "Not found" }));
	});

	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});

	const addr = server.address();
	if (!addr || typeof addr === "string") throw new Error("Expected TCP address");
	const origin = `http://127.0.0.1:${addr.port}`;

	return {
		baseUrl: `${origin}/v1`,
		origin,
		requests,
		modelsRequests,
		clearRequests() {
			requests.length = 0;
			modelsRequests.length = 0;
		},
		setModels(nextModels, format) {
			models = [...nextModels];
			if (format) modelsFormat = format;
		},
		setModelsError(error) {
			modelsError = error;
			remainingModelsErrors = error?.count ?? 0;
		},
		enqueue(response) {
			queue.push(response);
		},
		async close() {
			for (const cleanup of activeCleanups) cleanup();
			activeCleanups.clear();
			for (const socket of sockets) socket.destroy();
			sockets.clear();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

export function configureTestCustomProvider(
	dataDir: string,
	baseUrl: string,
	models: CustomModel[] = [{ id: "test-model-vision", image: true, reasoning: true, context: 128_000, maxTokens: 8_192 }],
): void {
	const modelId = models[0]?.id ?? "test-model-vision";
	const settings = {
		version: 1,
		customProvider: {
			baseUrl,
			authMode: "keyless" as const,
			models,
		},
		models: {
			strong: { model: { provider: "custom", id: modelId } },
			cheap: { model: { provider: "custom", id: modelId } },
			vision: { model: { provider: "custom", id: modelId } },
		},
	};
	fs.mkdirSync(dataDir, { recursive: true });
	fs.writeFileSync(path.join(dataDir, "settings.json"), `${JSON.stringify(settings, null, "\t")}\n`, "utf8");
}
