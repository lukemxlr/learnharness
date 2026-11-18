import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import http from "node:http";

const DEFAULT_MODELS = [
	{
		id: "gpt-test-1",
		slug: "gpt-test-1",
		display_name: "GPT Test 1",
		visibility: "list",
		context_length: 128000,
		max_output_tokens: 8192,
		input_modalities: ["text", "image"],
		supported_parameters: ["reasoning_effort"],
		reasoning: true,
		reasoning_levels: ["low", "medium", "high"],
	},
	{
		id: "gpt-test-7-pro",
		slug: "gpt-test-7-pro",
		display_name: "GPT Test 7 Pro",
		visibility: "list",
		context_length: 272000,
		max_output_tokens: 16384,
		input_modalities: ["text", "image"],
		supported_parameters: ["reasoning_effort"],
		reasoning: true,
		reasoning_levels: ["low", "medium", "high"],
	},
];

function readRawBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

function parseDataUrl(url) {
	const match = /^data:([^;,]+);base64,(.+)$/is.exec(url);
	if (!match) return { url };
	const buf = Buffer.from(match[2], "base64");
	return {
		url,
		mimeType: match[1].toLowerCase(),
		byteLength: buf.byteLength,
		sha256: createHash("sha256").update(buf).digest("hex"),
	};
}

function extractImages(value, out = []) {
	if (Array.isArray(value)) {
		for (const item of value) extractImages(item, out);
		return out;
	}
	if (!value || typeof value !== "object") return out;

	if (value.type === "image_url" && value.image_url && typeof value.image_url === "object") {
		if (typeof value.image_url.url === "string") {
			out.push(parseDataUrl(value.image_url.url));
		}
	} else if (value.type === "input_image" && typeof value.image_url === "string") {
		out.push(parseDataUrl(value.image_url));
	} else if (value.type === "image" && typeof value.data === "string") {
		const buf = Buffer.from(value.data, "base64");
		out.push({
			url: `data:${value.mimeType || "image/png"};base64,${value.data.slice(0, 32)}...`,
			mimeType: value.mimeType || "image/png",
			byteLength: buf.byteLength,
			sha256: createHash("sha256").update(buf).digest("hex"),
		});
	}

	for (const child of Object.values(value)) {
		if (child && typeof child === "object") extractImages(child, out);
	}
	return out;
}

function extractUserTexts(body) {
	const texts = [];
	const collectText = (content) => {
		if (typeof content === "string") {
			texts.push(content);
		} else if (Array.isArray(content)) {
			for (const part of content) {
				if (typeof part === "string") texts.push(part);
				else if (part && typeof part === "object" && typeof part.text === "string") texts.push(part.text);
			}
		}
	};

	if (Array.isArray(body.messages)) {
		for (const msg of body.messages) {
			if (!msg || typeof msg !== "object") continue;
			if (msg.role === "user" || msg.role === "tool") {
				collectText(msg.content);
			}
		}
	}
	if (typeof body.input === "string") {
		texts.push(body.input);
	} else if (Array.isArray(body.input)) {
		for (const item of body.input) {
			if (!item || typeof item !== "object") continue;
			if (item.role === "user" || item.type === "function_call_output") {
				collectText(item.content ?? item.output);
			}
		}
	}
	return texts;
}

function findToolSchema(tools, name) {
	if (!Array.isArray(tools)) return null;
	for (const tool of tools) {
		if (!tool || typeof tool !== "object") continue;
		if (tool.type === "function" && tool.function?.name === name) return tool.function;
		if (tool.name === name) return tool;
	}
	return null;
}

function toolAcceptsNodeId(toolDef) {
	const props = toolDef?.parameters?.properties;
	return Boolean(props && typeof props === "object" && ("nodeId" in props || "type" in props));
}

function buildDeterministicAction(body, images, userTexts) {
	const latestText = userTexts.length > 0 ? userTexts[userTexts.length - 1] : "";
	const joinedText = userTexts.join("\n");

	if (latestText.includes("[TRIGGER_MC]") || joinedText.includes("[TRIGGER_MC]")) {
		const quizTool = findToolSchema(body.tools, "quiz");
		const args = {
			...(toolAcceptsNodeId(quizTool) ? { type: "predict", nodeId: "root" } : {}),
			question: "In projectile motion near Earth's surface (ignoring air resistance), what is the vertical acceleration at the highest point?",
			options: [
				{ label: "Zero", value: "zero" },
				{ label: "g downward", value: "g_downward" },
				{ label: "g upward", value: "g_upward" },
				{ label: "Equal to horizontal velocity", value: "vx" },
			],
			explanation: "Gravity acts continuously downward with constant acceleration g throughout the trajectory, including at the peak.",
			correctAnswer: "g_downward",
		};
		return { kind: "tool_call", name: "quiz", arguments: args };
	}

	if (latestText.includes("[TRIGGER_FREE]") || joinedText.includes("[TRIGGER_FREE]")) {
		const explainTool = findToolSchema(body.tools, "explain");
		if (explainTool) {
			const args = {
				...(toolAcceptsNodeId(explainTool) ? { type: "predict", nodeId: "root" } : {}),
				question: "Explain why the horizontal and vertical components of projectile motion can be analyzed independently.",
				correctAnswer: "Gravity acts solely vertically, so horizontal acceleration is zero while vertical acceleration is -g; orthogonal axes do not couple.",
			};
			return { kind: "tool_call", name: "explain", arguments: args };
		}
		return {
			kind: "tool_call",
			name: "ask_user_question",
			arguments: {
				question: "Explain why the horizontal and vertical components of projectile motion can be analyzed independently.",
				details: "Provide a concise derivation or diagram.",
			},
		};
	}

	if (latestText.includes("[ECHO_VISION]") || joinedText.includes("[ECHO_VISION]")) {
		const bytesList = images.map((img) => img.byteLength ?? 0).join(",") || "0";
		const shaList = images.map((img) => (img.sha256 ? img.sha256.slice(0, 12) : "none")).join(",") || "none";
		return {
			kind: "text",
			chunks: [`[VISION_ECHO count=${images.length} bytes=${bytesList} sha256=${shaList}]`],
		};
	}

	if (latestText.includes("[STREAM_LONG]")) {
		const chunks = [];
		for (let i = 1; i <= 25; i++) {
			const pad = String(i).padStart(2, "0");
			chunks.push(`Chunk ${pad}/25: Projectile motion decomposes into uniform horizontal velocity and accelerated vertical fall. `);
		}
		return { kind: "text", chunks };
	}

	const summary = latestText.slice(0, 120).replace(/\s+/g, " ").trim();
	const imageNote = images.length > 0 ? ` [received ${images.length} image(s)]` : "";
	return {
		kind: "text",
		chunks: [`Synthetic tutor response${imageNote}: ${summary || "Ready to continue kinematics."}`],
	};
}

function base64UrlEncode(buf) {
	return Buffer.from(buf).toString("base64url");
}

function signMockJwt(payload, privateKey, kid) {
	const header = { alg: "RS256", typ: "JWT", kid };
	const encodedHeader = base64UrlEncode(JSON.stringify(header));
	const encodedPayload = base64UrlEncode(JSON.stringify(payload));
	const signingInput = `${encodedHeader}.${encodedPayload}`;
	const sig = sign("RSA-SHA256", Buffer.from(signingInput, "utf8"), privateKey);
	return `${signingInput}.${base64UrlEncode(sig)}`;
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function startMockProvider(options = {}) {
	const host = options.host || "127.0.0.1";
	const port = options.port ?? 0;

	const { publicKey, privateKey } = generateKeyPairSync("rsa", {
		modulusLength: 2048,
	});
	const publicJwk = publicKey.export({ format: "jwk" });
	const kid = "mock-oauth-key-1";
	publicJwk.kid = kid;
	publicJwk.alg = "RS256";
	publicJwk.use = "sig";

	const adminState = {
		modelsStatus: 200,
		modelsDelayMs: 0,
		extraModels: [],
		chunkDelayMs: options.chunkDelayMs ?? 80,
		failNextTurn: null,
		modelsFormat: "both", // "both" | "openai" | "chatgpt"
		oauthShouldFail: false,
		codeTtlMs: options.codeTtlMs ?? 300_000,
	};

	const ledger = {
		requests: [],
		modelsRequests: [],
		oauthRequests: [],
	};
	const authCodes = new Map();
	const refreshTokens = new Map();
	let requestSeq = 0;

	function currentModels() {
		const byId = new Map();
		for (const m of DEFAULT_MODELS) byId.set(m.id, m);
		for (const m of adminState.extraModels) {
			const id = m.id || m.slug;
			if (!id) continue;
			byId.set(id, {
				id,
				slug: m.slug || id,
				display_name: m.display_name || m.name || id,
				visibility: m.visibility || "list",
				context_length: m.context_length ?? 128000,
				max_output_tokens: m.max_output_tokens ?? 8192,
				input_modalities: m.input_modalities ?? ["text", "image"],
				supported_parameters: m.supported_parameters ?? ["reasoning_effort"],
				reasoning: m.reasoning ?? true,
				reasoning_levels: m.reasoning_levels ?? ["low", "medium", "high"],
			});
		}
		return [...byId.values()];
	}

	const server = http.createServer(async (req, res) => {
		const urlObj = new URL(req.url || "/", `http://${req.headers.host || `${host}:${port}`}`);
		const pathname = urlObj.pathname;
		const origin = `http://${req.headers.host || `${host}:${server.address().port}`}`;

		const sendJson = (status, data, extraHeaders = {}) => {
			const body = JSON.stringify(data);
			res.writeHead(status, {
				"Content-Type": "application/json",
				"Cache-Control": "no-store",
				...extraHeaders,
			});
			res.end(body);
		};

		try {
			// ── Admin & Inspection endpoints ──────────────────────────────────────
			if (pathname === "/__mock/health" && req.method === "GET") {
				return sendJson(200, { ok: true, port: server.address().port });
			}

			if (pathname === "/__mock/admin" && req.method === "POST") {
				const raw = await readRawBody(req);
				const patch = raw ? JSON.parse(raw) : {};
				if (patch.reset === true) {
					adminState.modelsStatus = 200;
					adminState.modelsDelayMs = 0;
					adminState.extraModels = [];
					adminState.chunkDelayMs = options.chunkDelayMs ?? 80;
					adminState.failNextTurn = null;
					adminState.modelsFormat = "both";
					adminState.oauthShouldFail = false;
					adminState.codeTtlMs = options.codeTtlMs ?? 300_000;
				}
				if (patch.resetModels === true) adminState.extraModels = [];
				if (typeof patch.modelsStatus === "number") adminState.modelsStatus = patch.modelsStatus;
				if (typeof patch.modelsDelayMs === "number") adminState.modelsDelayMs = patch.modelsDelayMs;
				if (Array.isArray(patch.extraModels)) adminState.extraModels = patch.extraModels;
				if (typeof patch.chunkDelayMs === "number") adminState.chunkDelayMs = patch.chunkDelayMs;
				if ("failNextTurn" in patch) adminState.failNextTurn = patch.failNextTurn;
				if (typeof patch.modelsFormat === "string") adminState.modelsFormat = patch.modelsFormat;
				if (typeof patch.oauthShouldFail === "boolean") adminState.oauthShouldFail = patch.oauthShouldFail;
				if (typeof patch.codeTtlMs === "number") adminState.codeTtlMs = patch.codeTtlMs;
				if (patch.expirePendingCodes === true) {
					const expiredAt = Date.now() - 1;
					for (const rec of authCodes.values()) rec.expiresAt = expiredAt;
				}
				return sendJson(200, { ok: true, state: adminState });
			}

			if (pathname === "/__mock/requests" && req.method === "GET") {
				return sendJson(200, {
					count: ledger.requests.length,
					requests: ledger.requests,
					modelsRequests: ledger.modelsRequests,
					oauthRequests: ledger.oauthRequests,
				});
			}

			if (pathname === "/__mock/requests" && req.method === "DELETE") {
				ledger.requests.length = 0;
				ledger.modelsRequests.length = 0;
				ledger.oauthRequests.length = 0;
				return sendJson(200, { ok: true });
			}

			// ── Model catalog endpoints ───────────────────────────────────────────
			if ((pathname === "/v1/models" || pathname === "/models") && req.method === "GET") {
				ledger.modelsRequests.push({
					timestamp: new Date().toISOString(),
					url: req.url,
					authorization: req.headers.authorization || null,
				});
				if (adminState.modelsDelayMs > 0) {
					await sleep(adminState.modelsDelayMs);
				}
				if (adminState.modelsStatus !== 200) {
					return sendJson(adminState.modelsStatus, {
						error: { message: `Mock injected models failure (${adminState.modelsStatus})`, code: "mock_models_error" },
					});
				}
				const models = currentModels();
				if (adminState.modelsFormat === "openai") {
					return sendJson(200, { object: "list", data: models });
				}
				if (adminState.modelsFormat === "chatgpt") {
					return sendJson(200, { models });
				}
				return sendJson(200, { object: "list", data: models, models });
			}

			// ── Chat Completions & Responses endpoints ────────────────────────────
			if ((pathname === "/v1/chat/completions" || pathname === "/v1/responses") && req.method === "POST") {
				const raw = await readRawBody(req);
				const body = raw ? JSON.parse(raw) : {};
				const images = extractImages(body);
				const userTexts = extractUserTexts(body);

				const entry = {
					seq: ++requestSeq,
					timestamp: new Date().toISOString(),
					endpoint: pathname,
					method: req.method,
					url: req.url,
					authorization: req.headers.authorization || null,
					model: typeof body.model === "string" ? body.model : undefined,
					stream: Boolean(body.stream),
					reasoningEffort: body.reasoning_effort ?? body.reasoning?.effort ?? null,
					messages: body.messages ?? null,
					input: body.input ?? null,
					tools: body.tools ?? null,
					images,
					userTexts,
					rawBody: body,
				};
				ledger.requests.push(entry);
				if (ledger.requests.length > 500) ledger.requests.shift();

				if (adminState.failNextTurn !== null) {
					const fault = adminState.failNextTurn;
					if (typeof fault === "number") {
						adminState.failNextTurn = null;
						return sendJson(fault, {
							error: { message: `Mock injected turn failure (${fault})`, type: "server_error" },
						});
					}
					if (fault && typeof fault === "object") {
						if (fault.remaining !== undefined) {
							fault.remaining -= 1;
							if (fault.remaining <= 0) adminState.failNextTurn = null;
						} else {
							adminState.failNextTurn = null;
						}
						if (fault.midStreamAbort) {
							res.writeHead(200, {
								"Content-Type": "text/event-stream",
								"Cache-Control": "no-cache",
								Connection: "keep-alive",
							});
							res.write(`data: ${JSON.stringify({ id: `chatcmpl_${entry.seq}`, object: "chat.completion.chunk", model: entry.model || "gpt-test-1", choices: [{ index: 0, delta: { role: "assistant", content: "Partial before drop " }, finish_reason: null }] })}\n\n`);
							await sleep(20);
							res.destroy(new Error("Mock injected mid-stream socket reset"));
							return;
						}
						return sendJson(fault.status || 500, fault.body || {
							error: { message: `Mock injected fault (${fault.status || 500})` },
						});
					}
				}

				const action = buildDeterministicAction(body, images, userTexts);
				const modelId = entry.model || "gpt-test-1";
				const completionId = `chatcmpl_mock_${entry.seq}`;
				const created = Math.floor(Date.now() / 1000);

				if (pathname === "/v1/chat/completions") {
					if (!body.stream) {
						const message =
							action.kind === "tool_call"
								? {
									role: "assistant",
									content: null,
									tool_calls: [{
										id: `call_mock_${entry.seq}`,
										type: "function",
										function: {
											name: action.name,
											arguments: JSON.stringify(action.arguments),
										},
									}],
								}
								: { role: "assistant", content: action.chunks.join("") };

						return sendJson(200, {
							id: completionId,
							object: "chat.completion",
							created,
							model: modelId,
							choices: [{
								index: 0,
								message,
								finish_reason: action.kind === "tool_call" ? "tool_calls" : "stop",
							}],
							usage: { prompt_tokens: 42, completion_tokens: 24, total_tokens: 66 },
						});
					}

					res.writeHead(200, {
						"Content-Type": "text/event-stream",
						"Cache-Control": "no-cache",
						Connection: "keep-alive",
					});

					let closed = false;
					req.on("close", () => { closed = true; });

					if (action.kind === "tool_call") {
						const argStr = JSON.stringify(action.arguments);
						const callId = `call_mock_${entry.seq}`;
						const frames = [
							{
								id: completionId,
								object: "chat.completion.chunk",
								created,
								model: modelId,
								choices: [{
									index: 0,
									delta: {
										role: "assistant",
										tool_calls: [{
											index: 0,
											id: callId,
											type: "function",
											function: { name: action.name, arguments: "" },
										}],
									},
									finish_reason: null,
								}],
							},
							{
								id: completionId,
								object: "chat.completion.chunk",
								created,
								model: modelId,
								choices: [{
									index: 0,
									delta: {
										tool_calls: [{
											index: 0,
											function: { arguments: argStr },
										}],
									},
									finish_reason: null,
								}],
							},
							{
								id: completionId,
								object: "chat.completion.chunk",
								created,
								model: modelId,
								choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
								usage: { prompt_tokens: 42, completion_tokens: 24, total_tokens: 66 },
							},
						];
						for (const frame of frames) {
							if (closed) return;
							res.write(`data: ${JSON.stringify(frame)}\n\n`);
						}
						res.write("data: [DONE]\n\n");
						res.end();
						return;
					}

					res.write(`data: ${JSON.stringify({
						id: completionId,
						object: "chat.completion.chunk",
						created,
						model: modelId,
						choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
					})}\n\n`);

					for (const chunk of action.chunks) {
						if (closed) return;
						if (adminState.chunkDelayMs > 0) await sleep(adminState.chunkDelayMs);
						if (closed) return;
						res.write(`data: ${JSON.stringify({
							id: completionId,
							object: "chat.completion.chunk",
							created,
							model: modelId,
							choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }],
						})}\n\n`);
					}

					if (!closed) {
						res.write(`data: ${JSON.stringify({
							id: completionId,
							object: "chat.completion.chunk",
							created,
							model: modelId,
							choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
							usage: { prompt_tokens: 42, completion_tokens: action.chunks.length * 4, total_tokens: 42 + action.chunks.length * 4 },
						})}\n\n`);
						res.write("data: [DONE]\n\n");
						res.end();
					}
					return;
				}

				// ── /v1/responses ──────────────────────────────────────────────────
				const responseId = `resp_mock_${entry.seq}`;
				const itemId = `msg_mock_${entry.seq}`;
				if (!body.stream) {
					const output = action.kind === "tool_call"
						? [{
							id: `fc_mock_${entry.seq}`,
							type: "function_call",
							call_id: `call_mock_${entry.seq}`,
							name: action.name,
							arguments: JSON.stringify(action.arguments),
						}]
						: [{
							id: itemId,
							type: "message",
							role: "assistant",
							content: [{ type: "output_text", text: action.chunks.join("") }],
						}];
					return sendJson(200, {
						id: responseId,
						object: "response",
						status: "completed",
						model: modelId,
						output,
						usage: { input_tokens: 42, output_tokens: 24, total_tokens: 66 },
					});
				}

				res.writeHead(200, {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
					Connection: "keep-alive",
				});
				let closed = false;
				req.on("close", () => { closed = true; });

				const writeEvent = (eventName, dataObj) => {
					if (closed) return;
					res.write(`event: ${eventName}\ndata: ${JSON.stringify(dataObj)}\n\n`);
				};

				writeEvent("response.created", {
					type: "response.created",
					response: { id: responseId, object: "response", status: "in_progress", model: modelId, output: [] },
				});

				if (action.kind === "tool_call") {
					const argStr = JSON.stringify(action.arguments);
					const fcItem = {
						id: `fc_mock_${entry.seq}`,
						type: "function_call",
						call_id: `call_mock_${entry.seq}`,
						name: action.name,
						arguments: argStr,
						status: "completed",
					};
					writeEvent("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { ...fcItem, arguments: "" } });
					writeEvent("response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", item_id: fcItem.id, output_index: 0, delta: argStr });
					writeEvent("response.output_item.done", { type: "response.output_item.done", output_index: 0, item: fcItem });
					writeEvent("response.completed", {
						type: "response.completed",
						response: { id: responseId, object: "response", status: "completed", model: modelId, output: [fcItem] },
					});
					res.end();
					return;
				}

				writeEvent("response.output_item.added", {
					type: "response.output_item.added",
					output_index: 0,
					item: { id: itemId, type: "message", role: "assistant", status: "in_progress", content: [] },
				});
				let fullText = "";
				for (const chunk of action.chunks) {
					if (closed) return;
					if (adminState.chunkDelayMs > 0) await sleep(adminState.chunkDelayMs);
					if (closed) return;
					fullText += chunk;
					writeEvent("response.output_text.delta", {
						type: "response.output_text.delta",
						item_id: itemId,
						output_index: 0,
						content_index: 0,
						delta: chunk,
					});
				}
				if (!closed) {
					const msgItem = {
						id: itemId,
						type: "message",
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: fullText }],
					};
					writeEvent("response.output_item.done", { type: "response.output_item.done", output_index: 0, item: msgItem });
					writeEvent("response.completed", {
						type: "response.completed",
						response: {
							id: responseId,
							object: "response",
							status: "completed",
							model: modelId,
							output: [msgItem],
							usage: { input_tokens: 42, output_tokens: action.chunks.length * 4, total_tokens: 42 + action.chunks.length * 4 },
						},
					});
					res.end();
				}
				return;
			}

			// ── Mock OAuth PKCE & OIDC Discovery ──────────────────────────────────
			if (pathname === "/.well-known/openid-configuration" && req.method === "GET") {
				return sendJson(200, {
					issuer: origin,
					authorization_endpoint: `${origin}/__oauth/authorize`,
					token_endpoint: `${origin}/__oauth/token`,
					revocation_endpoint: `${origin}/__oauth/revoke`,
					jwks_uri: `${origin}/__oauth/jwks.json`,
					response_types_supported: ["code"],
					code_challenge_methods_supported: ["S256"],
				});
			}

			if (pathname === "/__oauth/jwks.json" && req.method === "GET") {
				return sendJson(200, { keys: [publicJwk] });
			}

			if (pathname === "/__oauth/authorize" && req.method === "GET") {
				const clientId = urlObj.searchParams.get("client_id") || "mock-client";
				const redirectUri = urlObj.searchParams.get("redirect_uri") || "http://127.0.0.1/callback";
				const state = urlObj.searchParams.get("state") || "";
				const codeChallenge = urlObj.searchParams.get("code_challenge") || "";
				const codeChallengeMethod = urlObj.searchParams.get("code_challenge_method") || "S256";
				const mode = urlObj.searchParams.get("mode") || "redirect";

				ledger.oauthRequests.push({ endpoint: pathname, clientId, state, codeChallengeMethod });
				if (adminState.oauthShouldFail || !state || !codeChallenge || codeChallengeMethod !== "S256") {
					return sendJson(400, { error: "invalid_request", error_description: "Missing or invalid PKCE S256 parameters" });
				}

				const code = `mock_code_${randomBytes(12).toString("hex")}`;
				authCodes.set(code, {
					clientId,
					redirectUri,
					state,
					codeChallenge,
					used: false,
					expiresAt: Date.now() + adminState.codeTtlMs,
				});

				const cb = new URL(redirectUri);
				cb.searchParams.set("code", code);
				cb.searchParams.set("state", state);

				if (mode === "json") {
					return sendJson(200, { code, state, callbackUrl: cb.toString() });
				}
				res.writeHead(302, { Location: cb.toString(), "Cache-Control": "no-store" });
				res.end();
				return;
			}

			if (pathname === "/__oauth/token" && req.method === "POST") {
				const raw = await readRawBody(req);
				const contentType = (req.headers["content-type"] || "").toLowerCase();
				const params = contentType.includes("application/json")
					? JSON.parse(raw || "{}")
					: Object.fromEntries(new URLSearchParams(raw));

				ledger.oauthRequests.push({ endpoint: pathname, grantType: params.grant_type });

				if (adminState.oauthShouldFail) {
					return sendJson(400, { error: "invalid_grant", error_description: "Mock OAuth failure injected" });
				}

				if (params.grant_type === "authorization_code") {
					const record = authCodes.get(params.code);
					if (!record || record.used) {
						return sendJson(400, { error: "invalid_grant", error_description: "Invalid or used authorization code" });
					}
					if (Date.now() > record.expiresAt) {
						return sendJson(400, { error: "invalid_grant", error_description: "Authorization code expired" });
					}
					if (params.client_id !== undefined && params.client_id !== record.clientId) {
						return sendJson(400, { error: "invalid_grant", error_description: "client_id mismatch" });
					}
					if (params.redirect_uri !== undefined && params.redirect_uri !== record.redirectUri) {
						return sendJson(400, { error: "invalid_grant", error_description: "redirect_uri mismatch" });
					}
					if (params.state !== undefined && params.state !== record.state) {
						return sendJson(400, { error: "invalid_grant", error_description: "state mismatch" });
					}
					if (!params.code_verifier) {
						return sendJson(400, { error: "invalid_request", error_description: "Missing code_verifier" });
					}
					const computedChallenge = base64UrlEncode(createHash("sha256").update(params.code_verifier).digest());
					if (computedChallenge !== record.codeChallenge) {
						return sendJson(400, { error: "invalid_grant", error_description: "PKCE code_verifier mismatch" });
					}
					record.used = true;

					const accessToken = `mock_at_${randomBytes(16).toString("hex")}`;
					const refreshToken = `mock_rt_${randomBytes(16).toString("hex")}`;
					refreshTokens.set(refreshToken, { clientId: record.clientId, revoked: false });

					const now = Math.floor(Date.now() / 1000);
					const idToken = signMockJwt(
						{
							iss: origin,
							sub: "synth_sub_01",
							aud: record.clientId,
							email: "synthetic-learner@example.invalid",
							iat: now,
							exp: now + 3600,
							"https://api.openai.com/auth": {
								chatgpt_plan_type: "plus",
								chatgpt_account_id: "acct_synth_01",
							},
						},
						privateKey,
						kid,
					);

					return sendJson(200, {
						access_token: accessToken,
						refresh_token: refreshToken,
						id_token: idToken,
						token_type: "Bearer",
						expires_in: 3600,
						scope: "openid profile email offline_access",
					});
				}

				if (params.grant_type === "refresh_token") {
					const rt = refreshTokens.get(params.refresh_token);
					if (!rt || rt.revoked) {
						return sendJson(400, { error: "invalid_grant", error_description: "Refresh token revoked or unknown" });
					}
					const newAccess = `mock_at_${randomBytes(16).toString("hex")}`;
					const newRefresh = `mock_rt_${randomBytes(16).toString("hex")}`;
					rt.revoked = true;
					refreshTokens.set(newRefresh, { clientId: rt.clientId, revoked: false });
					const now = Math.floor(Date.now() / 1000);
					const idToken = signMockJwt(
						{
							iss: origin,
							sub: "synth_sub_01",
							aud: rt.clientId,
							email: "synthetic-learner@example.invalid",
							iat: now,
							exp: now + 3600,
						},
						privateKey,
						kid,
					);
					return sendJson(200, {
						access_token: newAccess,
						refresh_token: newRefresh,
						id_token: idToken,
						token_type: "Bearer",
						expires_in: 3600,
					});
				}

				return sendJson(400, { error: "unsupported_grant_type" });
			}

			if (pathname === "/__oauth/revoke" && req.method === "POST") {
				const raw = await readRawBody(req);
				const params = Object.fromEntries(new URLSearchParams(raw));
				ledger.oauthRequests.push({ endpoint: pathname, tokenTypeHint: params.token_type_hint });
				if (params.token && refreshTokens.has(params.token)) {
					refreshTokens.get(params.token).revoked = true;
				}
				return sendJson(200, { revoked: true });
			}

			return sendJson(404, { error: `Unknown mock route: ${req.method} ${pathname}` });
		} catch (err) {
			return sendJson(500, { error: err instanceof Error ? err.message : String(err) });
		}
	});

	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, resolve);
	});

	const addr = server.address();
	const actualPort = typeof addr === "object" && addr ? addr.port : port;
	const baseUrl = `http://${host}:${actualPort}`;

	return {
		host,
		port: actualPort,
		origin: baseUrl,
		baseUrl: `${baseUrl}/v1`,
		async admin(patch) {
			const res = await fetch(`${baseUrl}/__mock/admin`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(patch),
			});
			return res.json();
		},
		async getRequests() {
			const res = await fetch(`${baseUrl}/__mock/requests`);
			return res.json();
		},
		async clearRequests() {
			await fetch(`${baseUrl}/__mock/requests`, { method: "DELETE" });
		},
		async close() {
			await new Promise((resolve) => server.close(resolve));
		},
	};
}
