import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import type { Agent, AgentEvent } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { newAnswerResult, newProblemDismissedMarker, newUserMessage, PRACTICE_PROBLEM_TOOL, type LhMessage } from "../src/core/native-messages.ts";
import { configureTestCustomProvider, startTestProvider } from "./helpers/test-provider.ts";

// Isolate LH_DATA_DIR and LH_AUTH_FILE before importing server/store modules.
const TMP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lh-m3-handoff-"));
const PREV_DATA_DIR = process.env.LH_DATA_DIR;
const PREV_AUTH_FILE = process.env.LH_AUTH_FILE;
process.env.LH_DATA_DIR = TMP_DATA_DIR;
process.env.LH_AUTH_FILE = path.join(TMP_DATA_DIR, "auth.json");

const { discoverModels, syncCustomProvider } = await import("../src/server/custom-provider.ts");
const { persistCustomAuth } = await import("../src/server/custom-provider-auth.ts");
const { handleChatRequest } = await import("../src/server/chat-handler.ts");
const { runPiTurn } = await import("../src/server/pi/ui-stream.ts");
const {
	DEFAULT_STREAM_KEEPALIVE_MS,
	MAX_STREAM_KEEPALIVE_MS,
	MIN_STREAM_KEEPALIVE_MS,
	resolveStreamKeepaliveMs,
} = await import("../src/server/stream-keepalive.ts");
const { getPluginHost, initializePlugins } = await import("../src/server/plugins.ts");
const { isTurnRunning } = await import("../src/server/turn-liveness.ts");
const { runningTurn } = await import("../src/server/turn-runs.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { settingsStore } = await import("../src/store/settings.ts");
const { GET: jobsGET } = await import("../app/api/jobs/route.ts");
const { GET: chatGET } = await import("../app/api/chats/[id]/route.ts");
const { GET: streamGET } = await import("../app/api/chats/[id]/stream/route.ts");
const { SessionModel, sseEvents } = await import("../components/session-core.ts");

after(async () => {
	try {
		await (await getPluginHost()).dispose();
	} catch {
		/* not initialized */
	}
	if (PREV_DATA_DIR === undefined) delete process.env.LH_DATA_DIR;
	else process.env.LH_DATA_DIR = PREV_DATA_DIR;
	if (PREV_AUTH_FILE === undefined) delete process.env.LH_AUTH_FILE;
	else process.env.LH_AUTH_FILE = PREV_AUTH_FILE;
	fs.rmSync(TMP_DATA_DIR, { recursive: true, force: true });
});

async function readBody(req: http.IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf8");
}

async function sendWebResponse(webRes: Response, nodeRes: http.ServerResponse): Promise<void> {
	const headers: Record<string, string> = {};
	webRes.headers.forEach((value, key) => { headers[key] = value; });
	nodeRes.writeHead(webRes.status, headers);
	if (!webRes.body) { nodeRes.end(); return; }
	const reader = webRes.body.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			nodeRes.write(value);
		}
	} finally {
		reader.releaseLock();
		nodeRes.end();
	}
}

async function waitFor(pred: () => boolean, timeoutMs = 15_000, label = "condition"): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!pred()) {
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
		await new Promise((r) => setTimeout(r, 10));
	}
}

describe("M3 live-stream keepalive & two-client handoff", () => {
	it("runPiTurn emits SSE : ping\\n\\n while gated, stops on cancel() without aborting turn, and stops on done()", async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => { release = r; });
		let aborted = false;
		const listeners: Array<(e: AgentEvent) => void> = [];
		const agent = {
			state: { messages: [] },
			subscribe(fn: (e: AgentEvent) => void) { listeners.push(fn); return () => {}; },
			async continue() {
				for (const fn of listeners) fn({ type: "agent_start" } as AgentEvent);
				await gate;
				for (const fn of listeners) fn({ type: "agent_end", messages: [] } as AgentEvent);
			},
			abort() { aborted = true; },
		} as unknown as Agent;

		const handle = runPiTurn({ agent, onFinish() {}, heartbeatMs: 15 });

		let v1: ReadableStreamDefaultReader<Uint8Array> | undefined;
		let v2: ReadableStreamDefaultReader<Uint8Array> | undefined;
		try {
			// First view reads at least 2 `: ping\n\n` frames then cancels mid-turn
			v1 = handle.subscribe().getReader();
			const decoder = new TextDecoder();
			let v1Text = "";
			while (v1Text.split(": ping\n\n").length - 1 < 2) {
				const { done, value } = await v1.read();
				if (done) break;
				v1Text += decoder.decode(value, { stream: true });
			}
			assert.ok(v1Text.includes(": ping\n\n"), "expected SSE : ping\\n\\n heartbeat");
			await v1.cancel();
			assert.equal(aborted, false, "cancelling one view must never abort the server turn");

			// Second view attaches, receives at least one ping, then finishes cleanly
			v2 = handle.subscribe().getReader();
			let v2Text = "";
			while (!v2Text.includes(": ping\n\n")) {
				const { done, value } = await v2.read();
				if (done) break;
				v2Text += decoder.decode(value, { stream: true });
			}
			release();
			for (;;) {
				const { done, value } = await v2.read();
				if (done) break;
				v2Text += decoder.decode(value, { stream: true });
			}
			assert.ok(v2Text.endsWith("data: [DONE]\n\n"), "second view terminates with [DONE]");
		} finally {
			release();
			handle.abort();
			await v1?.cancel().catch(() => {});
			await v2?.cancel().catch(() => {});
		}
	});

	it("sseEvents ignores chunk-split CRLF : ping comments and notifies activity", async () => {
		const raw = ": pi" + "ng\r\n\r\ndata: {\"type\":\"agent_start\"}\r\n\r\n: ping\r\n\r\ndata: [DONE]\r\n\r\n";
		const bytes = new TextEncoder().encode(raw);
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3));
				controller.close();
			},
		});
		let activities = 0;
		const yielded: Record<string, unknown>[] = [];
		const gen = sseEvents(stream.getReader(), () => { activities++; });
		let doneResult = false;
		for (;;) {
			const step = await gen.next();
			if (step.done) { doneResult = step.value; break; }
			yielded.push(step.value);
		}
		assert.equal(doneResult, true);
		assert.deepEqual(yielded, [{ type: "agent_start" }]);
		assert.ok(activities >= 4, "onActivity should fire on ping comments as well as data frames");
	});

	it("resumeStream clears transient STREAM_DROPPED error on turn-settled while preserving genuine turnError", async () => {
		let turnErrorOnServer: string | undefined;
		let failStream = true;
		const dropModel = new SessionModel({
			chatId: "chat_drop",
			initialMessages: [],
			fetch: async (url) => {
				const u = String(url);
				if (u === "/api/chat") return Response.json({ ok: true });
				if (u.endsWith("/stream")) {
					return failStream
						? new Response('data: {"type":"agent_start"}\n\n')
						: new Response('data: {"type":"turn-settled"}\n\ndata: [DONE]\n\n');
				}
				return Response.json({
					messages: [{ id: "u1", role: "user", content: "hi", timestamp: 1 }],
					turnInFlight: false,
					...(turnErrorOnServer ? { turnError: turnErrorOnServer } : {}),
				});
			},
		});
		try {
			await dropModel.send({ type: "text", text: "hi" });
			assert.equal(dropModel.status, "error");
			assert.equal(dropModel.getState().error?.message, "The connection dropped before the turn completed.");

			// Turn settled cleanly on server; resumeStream(true) recovers and clears stale banner
			failStream = false;
			await dropModel.resumeStream(true);
			assert.equal(dropModel.status, "ready");
			assert.equal(dropModel.getState().error, null);

			// Genuine server turnError is still restored by readRecord/reconcile
			failStream = true;
			await dropModel.send({ type: "text", text: "hi again" });
			assert.equal(dropModel.status, "error");
			failStream = false;
			turnErrorOnServer = "The reply could not be saved.";
			await dropModel.resumeStream(true);
			assert.equal(dropModel.status, "ready");
			assert.equal(dropModel.getState().error?.message, "The reply could not be saved.");
		} finally {
			dropModel.stop();
		}
	});

	it("real two-client concurrent HTTP/SSE live-stream handoff via test provider runs strictly 1 model call", async () => {
		const provider = await startTestProvider();
		try {
			configureTestCustomProvider(TMP_DATA_DIR, provider.baseUrl);
			const bindingId = "0123456789abcdef0123456789abcdef";
			const currentSettings = settingsStore.readSettings();
			if (currentSettings?.customProvider) {
				settingsStore.writeSettings({
					...currentSettings,
					customProvider: { ...currentSettings.customProvider, credentialBindingId: bindingId },
				});
				persistCustomAuth({ version: 1, id: bindingId, baseUrl: provider.baseUrl, authMode: "keyless" }, undefined);
			}
			syncCustomProvider();
			const discovered = await discoverModels(provider.baseUrl);
			assert.equal(discovered.ok, true);
			if (!discovered.ok) return;
			const modelId = discovered.models[0]!.id;

			let releaseGate!: () => void;
			const gate = new Promise<void>((r) => { releaseGate = r; });
			provider.enqueue({ gate, chunks: ["First part ", "and final handoff reply."] });

			const chat = chatStore.createChat("Two-Client Handoff");
			chatStore.saveSettings(chat.id, {
				model: { provider: "custom", id: modelId },
			});
			await initializePlugins();

			const pendingPosts = new Set<Promise<void>>();
			const server = http.createServer(async (req, res) => {
				try {
					const url = new URL(req.url ?? "/", "http://127.0.0.1");
					if (req.method === "POST" && url.pathname === "/api/chat") {
						const task = (async () => {
							const raw = await readBody(req);
							const webReq = new Request(`http://127.0.0.1${url.pathname}`, {
								method: "POST",
								headers: { "Content-Type": "application/json" },
								body: raw,
							});
							const webRes = await handleChatRequest(webReq);
							await sendWebResponse(webRes, res);
						})();
						pendingPosts.add(task);
						try {
							await task;
						} finally {
							pendingPosts.delete(task);
						}
						return;
					}
					if (req.method === "GET" && url.pathname === "/api/jobs") {
						const webReq = new Request(`http://127.0.0.1${url.pathname}${url.search}`);
						await sendWebResponse(await jobsGET(webReq), res);
						return;
					}
					if (req.method === "GET" && url.pathname === `/api/chats/${chat.id}`) {
						const webReq = new Request(`http://127.0.0.1${url.pathname}`);
						await sendWebResponse(await chatGET(webReq, { params: Promise.resolve({ id: chat.id }) }), res);
						return;
					}
					if (req.method === "GET" && url.pathname === `/api/chats/${chat.id}/stream`) {
						const webReq = new Request(`http://127.0.0.1${url.pathname}`);
						await sendWebResponse(await streamGET(webReq, { params: Promise.resolve({ id: chat.id }) }), res);
						return;
					}
					res.writeHead(404);
					res.end("Not found");
				} catch (err) {
					res.writeHead(500);
					res.end(String(err));
				}
			});

			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const port = (server.address() as AddressInfo).port;
			const baseOrigin = `http://127.0.0.1:${port}`;
			const httpFetch: typeof fetch = (input, init) => {
				const target = typeof input === "string" && input.startsWith("/") ? `${baseOrigin}${input}` : input;
				return fetch(target, init);
			};

			const clientA = new SessionModel({ chatId: chat.id, initialMessages: [], fetch: httpFetch });
			const clientB = new SessionModel({ chatId: chat.id, initialMessages: [], fetch: httpFetch });
			let clientASend: Promise<boolean> | undefined;
			let clientBAttach: Promise<void> | undefined;
			try {
				// Client A starts the turn
				clientASend = clientA.send({ type: "text", text: "Explain Pythagoras" });
				await waitFor(
					() => {
						if (clientA.status === "error") {
							throw new Error(`clientA failed before provider request: ${clientA.getState().error?.message}`);
						}
						return provider.requests.length === 1;
					},
					60_000,
					"provider request 1",
				);
				await waitFor(() => clientA.status === "submitted" || clientA.status === "streaming", 30_000, "clientA attached");

				// Client B checks /api/jobs and /api/chats/[id] (verifying no-store headers) and attaches mid-turn
				const jobsRes = await httpFetch(`/api/jobs?chatId=${encodeURIComponent(chat.id)}`);
				assert.equal(jobsRes.headers.get("cache-control"), "no-store");
				const jobsJson = (await jobsRes.json()) as { turnInFlight: boolean };
				assert.equal(jobsJson.turnInFlight, true);

				const chatRes = await httpFetch(`/api/chats/${encodeURIComponent(chat.id)}`);
				assert.equal(chatRes.headers.get("cache-control"), "no-store");
				const chatJson = (await chatRes.json()) as { turnInFlight: boolean };
				assert.equal(chatJson.turnInFlight, true);

				clientBAttach = clientB.resumeStream(true);
				await waitFor(() => clientB.status === "submitted" || clientB.status === "streaming", 30_000, "clientB attached");

				// Release the gated model response; both clients receive live completion
				releaseGate();
				const sendOk = await clientASend;
				await clientBAttach;

				assert.equal(sendOk, true);
				assert.equal(provider.requests.length, 1, "strictly ONE model run must occur across both clients");
				assert.equal(clientA.status, "ready");
				assert.equal(clientB.status, "ready");
				assert.equal(clientA.getState().error, null);
				assert.equal(clientB.getState().error, null);

				const textA = clientA.getState().nativeMessages.filter((m) => m.role === "assistant").map((m) => JSON.stringify(m.content)).join("");
				const textB = clientB.getState().nativeMessages.filter((m) => m.role === "assistant").map((m) => JSON.stringify(m.content)).join("");
				assert.ok(textA.includes("First part and final handoff reply."), `Client A missing text: ${textA}`);
				assert.ok(textB.includes("First part and final handoff reply."), `Client B missing text: ${textB}`);
				assert.equal(clientA.getState().nativeMessages.length, 2, "Client A should have 1 user + 1 assistant message (no duplicates)");
				assert.equal(clientB.getState().nativeMessages.length, 2, "Client B should have 1 user + 1 assistant message (no duplicates)");
			} finally {
				releaseGate();
				clientA.stop();
				clientB.stop();
				await Promise.allSettled([clientASend, clientBAttach, ...pendingPosts].filter(Boolean));
				runningTurn(chat.id)?.abort();
				await waitFor(() => !isTurnRunning(chat.id) && !runningTurn(chat.id), 30_000, "turn cleanup").catch(() => {});
				server.closeAllConnections();
				await new Promise<void>((resolve) => server.close(() => resolve()));
			}
		} finally {
			await provider.close();
		}
	});

	it("resolveStreamKeepaliveMs validates/clamps and runPiTurn honors LH_STREAM_KEEPALIVE_MS unless overridden", async () => {
		assert.equal(resolveStreamKeepaliveMs(undefined), DEFAULT_STREAM_KEEPALIVE_MS);
		assert.equal(resolveStreamKeepaliveMs(""), DEFAULT_STREAM_KEEPALIVE_MS);
		assert.equal(resolveStreamKeepaliveMs("0"), DEFAULT_STREAM_KEEPALIVE_MS);
		assert.equal(resolveStreamKeepaliveMs("-5"), DEFAULT_STREAM_KEEPALIVE_MS);
		assert.equal(resolveStreamKeepaliveMs("abc"), DEFAULT_STREAM_KEEPALIVE_MS);
		assert.equal(resolveStreamKeepaliveMs("60"), 60);
		assert.equal(resolveStreamKeepaliveMs("1"), MIN_STREAM_KEEPALIVE_MS);
		assert.equal(resolveStreamKeepaliveMs("999999999999"), MAX_STREAM_KEEPALIVE_MS);

		const prevEnv = process.env.LH_STREAM_KEEPALIVE_MS;
		const makeTurn = (heartbeatMs?: number) => {
			let release!: () => void;
			const gate = new Promise<void>((r) => { release = r; });
			const listeners: Array<(e: AgentEvent) => void> = [];
			const agent = {
				state: { messages: [] },
				subscribe(fn: (e: AgentEvent) => void) { listeners.push(fn); return () => {}; },
				async continue() {
					for (const fn of listeners) fn({ type: "agent_start" } as AgentEvent);
					await gate;
					for (const fn of listeners) fn({ type: "agent_end", messages: [] } as AgentEvent);
				},
				abort() {},
			} as unknown as Agent;
			const handle = runPiTurn({ agent, onFinish() {}, ...(heartbeatMs !== undefined ? { heartbeatMs } : {}) });
			return { handle, release: () => release() };
		};

		try {
			process.env.LH_STREAM_KEEPALIVE_MS = "60";
			const envTurn = makeTurn(undefined);
			let r1: ReadableStreamDefaultReader<Uint8Array> | undefined;
			try {
				r1 = envTurn.handle.subscribe().getReader();
				const decoder = new TextDecoder();
				let buf = "";
				while (!buf.includes(": ping\n\n")) {
					const { done, value } = await r1.read();
					if (done) break;
					buf += decoder.decode(value, { stream: true });
				}
				assert.ok(buf.includes(": ping\n\n"), "runPiTurn should emit : ping\\n\\n from LH_STREAM_KEEPALIVE_MS");
			} finally {
				envTurn.release();
				envTurn.handle.abort();
				await r1?.cancel().catch(() => {});
			}

			// Explicit heartbeatMs: 0 overrides LH_STREAM_KEEPALIVE_MS
			const disabledTurn = makeTurn(0);
			let r2: ReadableStreamDefaultReader<Uint8Array> | undefined;
			try {
				r2 = disabledTurn.handle.subscribe().getReader();
				await new Promise((r) => setTimeout(r, 120));
				disabledTurn.release();
				const decoder = new TextDecoder();
				let buf = "";
				for (;;) {
					const { done, value } = await r2.read();
					if (done) break;
					buf += decoder.decode(value, { stream: true });
				}
				assert.equal(buf.includes(": ping\n\n"), false, "explicit heartbeatMs: 0 must override LH_STREAM_KEEPALIVE_MS");
			} finally {
				disabledTurn.release();
				disabledTurn.handle.abort();
				await r2?.cancel().catch(() => {});
			}
		} finally {
			if (prevEnv === undefined) delete process.env.LH_STREAM_KEEPALIVE_MS;
			else process.env.LH_STREAM_KEEPALIVE_MS = prevEnv;
		}
	});

	it("sseEvents normalizes 1-byte chunked bare CR (\\r\\r) framing and flushes at EOF", async () => {
		const raw = ": ping\r\rdata: {\"type\":\"agent_start\"}\r\rdata: [DONE]\r\r";
		const bytes = new TextEncoder().encode(raw);
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (let i = 0; i < bytes.length; i++) controller.enqueue(bytes.slice(i, i + 1));
				controller.close();
			},
		});
		let activities = 0;
		const yielded: Record<string, unknown>[] = [];
		const gen = sseEvents(stream.getReader(), () => { activities++; });
		let doneResult = false;
		for (;;) {
			const step = await gen.next();
			if (step.done) { doneResult = step.value; break; }
			yielded.push(step.value);
		}
		assert.equal(doneResult, true);
		assert.deepEqual(yielded, [{ type: "agent_start" }]);
		assert.ok(activities >= 3);
	});

	it("SessionModel recovers from reconciliation=failed via readRecord() and skips 409 retry on continueIfOwed", async () => {
		let failRecord = true;
		let streamCalls = 0;
		let postCalls = 0;
		let jobsCalls = 0;

		const messagesWithOwed: LhMessage[] = [
			{ ...newUserMessage("Quiz me"), id: "u1" } as LhMessage,
			{ ...fauxAssistantMessage([fauxToolCall("quiz", { questions: [] }, { id: "call_q1" })]), id: "a1" } as unknown as LhMessage,
			{
				...newAnswerResult("call_q1", "quiz", {
					kind: "quiz",
					questionText: "2+2?",
					dontKnow: false,
					answers: [{ question: "2+2?", selected: ["4"], correct: true }],
					answeredAt: "2026-11-19T00:00:00Z",
				}),
				id: "tr1",
			} as LhMessage,
		];

		const m = new SessionModel({
			chatId: "chat_reconcile_continue",
			initialMessages: [],
			pollMs: 5,
			waitMaxMs: 50,
			fetch: async (url, init) => {
				const u = String(url);
				if (u === "/api/chat" && init?.method === "POST") {
					postCalls++;
					const body = JSON.parse(String(init.body)) as { input?: { type?: string } };
					if (body.input?.type === "continue") {
						return Response.json({ error: "Turn already running" }, { status: 409 });
					}
					return Response.json({ ok: true });
				}
				if (u.startsWith("/api/jobs")) {
					jobsCalls++;
					return Response.json({ jobs: [], turnInFlight: false });
				}
				if (u === "/api/chats/chat_reconcile_continue") {
					if (failRecord) return new Response("Server error", { status: 500 });
					return Response.json({ messages: messagesWithOwed, turnInFlight: false });
				}
				if (u === "/api/chats/chat_reconcile_continue/stream") {
					streamCalls++;
					return new Response('data: {"type":"turn-settled"}\n\ndata: [DONE]\n\n', {
						status: 200,
						headers: { "Content-Type": "text/event-stream" },
					});
				}
				throw new Error(`Unexpected fetch: ${u}`);
			},
		});

		try {
			// 1. Failing reconcile() sets reconciliation = "failed" and blocks send()
			const ok1 = await m.reconcile();
			assert.equal(ok1, false);
			assert.equal(m.getState().reconciliation, "failed");
			assert.equal(m.readyRef, false);
			assert.equal(await m.send({ type: "text", text: "blocked" }), false);
			assert.equal(postCalls, 0);

			// 2. Subsequent successful readRecord() restores reconciliation = "ready"
			failRecord = false;
			await m.readRecord();
			assert.equal(m.getState().reconciliation, "ready");
			assert.equal(m.readyRef, true);

			// 3. continueIfOwed hitting 409 skips poll/retry loop and reattaches cleanly
			await m.continueIfOwed(messagesWithOwed);
			assert.equal(postCalls, 1, "continue must not retry on 409");
			assert.equal(jobsCalls, 0, "continue 409 must not poll /api/jobs");
			assert.equal(streamCalls, 1, "continue 409 must attach via resumeStream(true)");
			assert.equal(m.status, "ready");
			assert.equal(m.getState().error, null);
		} finally {
			m.stop();
		}
	});

	it("two-client concurrent continueIfOwed 409 race via HTTP + handleChatRequest runs strictly 1 model call", async () => {
		const provider = await startTestProvider();
		try {
			configureTestCustomProvider(TMP_DATA_DIR, provider.baseUrl);
			const bindingId = "fedcba9876543210fedcba9876543210";
			const currentSettings = settingsStore.readSettings();
			if (currentSettings?.customProvider) {
				settingsStore.writeSettings({
					...currentSettings,
					customProvider: { ...currentSettings.customProvider, credentialBindingId: bindingId },
				});
				persistCustomAuth({ version: 1, id: bindingId, baseUrl: provider.baseUrl, authMode: "keyless" }, undefined);
			}
			syncCustomProvider();
			const discovered = await discoverModels(provider.baseUrl);
			assert.equal(discovered.ok, true);
			if (!discovered.ok) return;
			const modelId = discovered.models[0]!.id;

			let releaseGate!: () => void;
			const gate = new Promise<void>((r) => { releaseGate = r; });
			provider.enqueue({ gate, chunks: ["Great answer, ", "let us continue!"] });

			const chat = chatStore.createChat("Concurrent Continue Race");
			chatStore.saveSettings(chat.id, { model: { provider: "custom", id: modelId } });
			const seedMessages: LhMessage[] = [
				{ ...newUserMessage("Quiz me"), id: "u_seed" } as LhMessage,
				{ ...fauxAssistantMessage([fauxToolCall("quiz", { questions: [] }, { id: "call_seed" })]), id: "a_seed" } as unknown as LhMessage,
				{
					...newAnswerResult("call_seed", "quiz", {
						kind: "quiz",
						questionText: "2+2?",
						dontKnow: false,
						answers: [{ question: "2+2?", selected: ["4"], correct: true }],
						answeredAt: "2026-11-19T00:00:00Z",
					}),
					id: "tr_seed",
				} as LhMessage,
			];
			chatStore.saveMessages(chat.id, seedMessages);
			await initializePlugins();

			let post409Count = 0;
			const pendingPosts = new Set<Promise<void>>();
			const server = http.createServer(async (req, res) => {
				try {
					const url = new URL(req.url ?? "/", "http://127.0.0.1");
					if (req.method === "POST" && url.pathname === "/api/chat") {
						const task = (async () => {
							const raw = await readBody(req);
							const webReq = new Request(`http://127.0.0.1${url.pathname}`, {
								method: "POST",
								headers: { "Content-Type": "application/json" },
								body: raw,
							});
							const webRes = await handleChatRequest(webReq);
							if (webRes.status === 409) post409Count++;
							await sendWebResponse(webRes, res);
						})();
						pendingPosts.add(task);
						try {
							await task;
						} finally {
							pendingPosts.delete(task);
						}
						return;
					}
					if (req.method === "GET" && url.pathname === "/api/jobs") {
						const webReq = new Request(`http://127.0.0.1${url.pathname}${url.search}`);
						await sendWebResponse(await jobsGET(webReq), res);
						return;
					}
					if (req.method === "GET" && url.pathname === `/api/chats/${chat.id}`) {
						const webReq = new Request(`http://127.0.0.1${url.pathname}`);
						await sendWebResponse(await chatGET(webReq, { params: Promise.resolve({ id: chat.id }) }), res);
						return;
					}
					if (req.method === "GET" && url.pathname === `/api/chats/${chat.id}/stream`) {
						const webReq = new Request(`http://127.0.0.1${url.pathname}`);
						await sendWebResponse(await streamGET(webReq, { params: Promise.resolve({ id: chat.id }) }), res);
						return;
					}
					res.writeHead(404);
					res.end("Not found");
				} catch (err) {
					res.writeHead(500);
					res.end(String(err));
				}
			});

			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const port = (server.address() as AddressInfo).port;
			const baseOrigin = `http://127.0.0.1:${port}`;
			const httpFetch: typeof fetch = (input, init) => {
				const target = typeof input === "string" && input.startsWith("/") ? `${baseOrigin}${input}` : input;
				return fetch(target, init);
			};

			const clientA = new SessionModel({ chatId: chat.id, initialMessages: seedMessages, fetch: httpFetch, pollMs: 10, waitMaxMs: 200 });
			const clientB = new SessionModel({ chatId: chat.id, initialMessages: seedMessages, fetch: httpFetch, pollMs: 10, waitMaxMs: 200 });
			let pA: Promise<void> | undefined;
			let pB: Promise<void> | undefined;
			try {
				pA = clientA.continueIfOwed(seedMessages);
				await waitFor(() => provider.requests.length === 1, 60_000, "provider request 1");
				pB = clientB.continueIfOwed(seedMessages);
				await waitFor(() => post409Count === 1, 30_000, "clientB 409 response");
				await waitFor(() => clientB.status === "submitted" || clientB.status === "streaming", 30_000, "clientB reattached");

				releaseGate();
				await Promise.all([pA, pB]);

				assert.equal(post409Count, 1);
				assert.equal(provider.requests.length, 1, "concurrent continueIfOwed must trigger strictly 1 model run");
				assert.equal(clientA.status, "ready");
				assert.equal(clientB.status, "ready");
				assert.equal(clientA.getState().error, null);
				assert.equal(clientB.getState().error, null);

				const textA = clientA.getState().nativeMessages.filter((m) => m.role === "assistant").map((m) => JSON.stringify(m.content)).join("");
				const textB = clientB.getState().nativeMessages.filter((m) => m.role === "assistant").map((m) => JSON.stringify(m.content)).join("");
				assert.ok(textA.includes("Great answer, let us continue!"), `Client A missing text: ${textA}`);
				assert.ok(textB.includes("Great answer, let us continue!"), `Client B missing text: ${textB}`);
			} finally {
				releaseGate();
				clientA.stop();
				clientB.stop();
				await Promise.allSettled([pA, pB, ...pendingPosts].filter(Boolean));
				runningTurn(chat.id)?.abort();
				await waitFor(() => !isTurnRunning(chat.id) && !runningTurn(chat.id), 30_000, "turn cleanup").catch(() => {});
				server.closeAllConnections();
				await new Promise<void>((resolve) => server.close(() => resolve()));
			}
		} finally {
			await provider.close();
		}
	});

	it("sequential/skewed continueIfOwed after Turn 1 settled returns 409 with 1 provider call and syncs Client B cleanly", async () => {
		const provider = await startTestProvider();
		try {
			configureTestCustomProvider(TMP_DATA_DIR, provider.baseUrl);
			const bindingId = "11223344556677889900aabbccddeeff";
			const currentSettings = settingsStore.readSettings();
			if (currentSettings?.customProvider) {
				settingsStore.writeSettings({
					...currentSettings,
					customProvider: { ...currentSettings.customProvider, credentialBindingId: bindingId },
				});
				persistCustomAuth({ version: 1, id: bindingId, baseUrl: provider.baseUrl, authMode: "keyless" }, undefined);
			}
			syncCustomProvider();
			const discovered = await discoverModels(provider.baseUrl);
			assert.equal(discovered.ok, true);
			if (!discovered.ok) return;
			const modelId = discovered.models[0]!.id;

			provider.enqueue({ text: "Turn 1 settled cleanly." });
			provider.enqueue({ text: "Phantom 2nd model run!" });

			const chat = chatStore.createChat("Sequential Continue Skew");
			chatStore.saveSettings(chat.id, { model: { provider: "custom", id: modelId } });
			const seedMessages: LhMessage[] = [
				{ ...newUserMessage("Quiz me"), id: "u_seq" } as LhMessage,
				{ ...fauxAssistantMessage([fauxToolCall("quiz", { questions: [] }, { id: "call_seq" })]), id: "a_seq" } as unknown as LhMessage,
				{
					...newAnswerResult("call_seq", "quiz", {
						kind: "quiz",
						questionText: "2+2?",
						dontKnow: false,
						answers: [{ question: "2+2?", selected: ["4"], correct: true }],
						answeredAt: "2026-11-19T00:00:00Z",
					}),
					id: "tr_seq",
				} as LhMessage,
			];
			chatStore.saveMessages(chat.id, seedMessages);
			await initializePlugins();

			const postStatuses: number[] = [];
			const pendingPosts = new Set<Promise<void>>();
			const server = http.createServer(async (req, res) => {
				try {
					const url = new URL(req.url ?? "/", "http://127.0.0.1");
					if (req.method === "POST" && url.pathname === "/api/chat") {
						const task = (async () => {
							const raw = await readBody(req);
							const webReq = new Request(`http://127.0.0.1${url.pathname}`, {
								method: "POST",
								headers: { "Content-Type": "application/json" },
								body: raw,
							});
							const webRes = await handleChatRequest(webReq);
							postStatuses.push(webRes.status);
							await sendWebResponse(webRes, res);
						})();
						pendingPosts.add(task);
						try {
							await task;
						} finally {
							pendingPosts.delete(task);
						}
						return;
					}
					if (req.method === "GET" && url.pathname === "/api/jobs") {
						const webReq = new Request(`http://127.0.0.1${url.pathname}${url.search}`);
						await sendWebResponse(await jobsGET(webReq), res);
						return;
					}
					if (req.method === "GET" && url.pathname === `/api/chats/${chat.id}`) {
						const webReq = new Request(`http://127.0.0.1${url.pathname}`);
						await sendWebResponse(await chatGET(webReq, { params: Promise.resolve({ id: chat.id }) }), res);
						return;
					}
					if (req.method === "GET" && url.pathname === `/api/chats/${chat.id}/stream`) {
						const webReq = new Request(`http://127.0.0.1${url.pathname}`);
						await sendWebResponse(await streamGET(webReq, { params: Promise.resolve({ id: chat.id }) }), res);
						return;
					}
					res.writeHead(404);
					res.end("Not found");
				} catch (err) {
					res.writeHead(500);
					res.end(String(err));
				}
			});

			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const port = (server.address() as AddressInfo).port;
			const baseOrigin = `http://127.0.0.1:${port}`;
			const httpFetch: typeof fetch = (input, init) => {
				const target = typeof input === "string" && input.startsWith("/") ? `${baseOrigin}${input}` : input;
				return fetch(target, init);
			};

			const clientA = new SessionModel({ chatId: chat.id, initialMessages: seedMessages, fetch: httpFetch, pollMs: 10, waitMaxMs: 200 });
			const clientB = new SessionModel({ chatId: chat.id, initialMessages: seedMessages, fetch: httpFetch, pollMs: 10, waitMaxMs: 200 });
			try {
				await clientA.continueIfOwed(seedMessages);
				await waitFor(() => !isTurnRunning(chat.id) && !runningTurn(chat.id), 45_000, "Turn 1 settled");
				assert.equal(provider.requests.length, 1);
				assert.equal(clientA.status, "ready");
				assert.equal(clientA.getState().error, null);

				// Client B still holds the pre-settle seedMessages and fires continueIfOwed sequentially after Turn 1 settled
				await clientB.continueIfOwed(seedMessages);

				assert.deepEqual(postStatuses, [200, 409], "stale sequential continue must be rejected with 409");
				assert.equal(provider.requests.length, 1, "stale sequential continue must never start a 2nd model run");
				assert.equal(clientB.status, "ready");
				assert.equal(clientB.getState().error, null);
				assert.equal(isTurnRunning(chat.id), false);

				const textB = clientB.getState().nativeMessages.filter((m) => m.role === "assistant").map((m) => JSON.stringify(m.content)).join("");
				assert.ok(textB.includes("Turn 1 settled cleanly."), `Client B missing Turn 1 assistant text: ${textB}`);
				assert.equal(clientB.getState().nativeMessages.length, 4);
			} finally {
				clientA.stop();
				clientB.stop();
				await Promise.allSettled([...pendingPosts]);
				runningTurn(chat.id)?.abort();
				await waitFor(() => !isTurnRunning(chat.id) && !runningTurn(chat.id), 30_000, "turn cleanup").catch(() => {});
				server.closeAllConnections();
				await new Promise<void>((resolve) => server.close(() => resolve()));
			}
		} finally {
			await provider.close();
		}
	});

	it("rejects stale continue on a posed practice problem (409, 1 provider call) while problem-dismissed + continue succeeds", async () => {
		const provider = await startTestProvider();
		try {
			configureTestCustomProvider(TMP_DATA_DIR, provider.baseUrl);
			const bindingId = "ffeeddccbbaa00998877665544332211";
			const currentSettings = settingsStore.readSettings();
			if (currentSettings?.customProvider) {
				settingsStore.writeSettings({
					...currentSettings,
					customProvider: { ...currentSettings.customProvider, credentialBindingId: bindingId },
				});
				persistCustomAuth({ version: 1, id: bindingId, baseUrl: provider.baseUrl, authMode: "keyless" }, undefined);
			}
			syncCustomProvider();
			const discovered = await discoverModels(provider.baseUrl);
			assert.equal(discovered.ok, true);
			if (!discovered.ok) return;
			const modelId = discovered.models[0]!.id;

			provider.enqueue({
				toolCalls: [
					{
						id: "call_p1",
						name: PRACTICE_PROBLEM_TOOL,
						arguments: { statement: "Solve 2x = 6", mode: "recall", modelSolution: "x = 3" },
					},
				],
			});
			provider.enqueue({ text: "Problem dismissed, moving on." });

			const chat = chatStore.createChat("Practice Continue Guard", "practice");
			chatStore.saveSettings(chat.id, { model: { provider: "custom", id: modelId } });
			await initializePlugins();

			try {
				// 1. Turn 1 poses the practice problem (providerRequests === 1)
				const poseRes = await handleChatRequest(
					new Request("http://127.0.0.1/api/chat", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ chatId: chat.id, input: { type: "text", text: "Practice algebra" } }),
					}),
				);
				assert.equal(poseRes.status, 200);
				await poseRes.arrayBuffer();
				await waitFor(() => !isTurnRunning(chat.id) && !runningTurn(chat.id), 45_000, "pose turn settled");
				assert.equal(provider.requests.length, 1);

				// 2. Stale { type: "continue" } on the posed problem must return 409 with zero extra provider requests
				const staleContinueRes = await handleChatRequest(
					new Request("http://127.0.0.1/api/chat", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ chatId: chat.id, input: { type: "continue" } }),
					}),
				);
				assert.equal(staleContinueRes.status, 409);
				const staleBody = (await staleContinueRes.json()) as { error?: string };
				assert.match(staleBody.error ?? "", /no longer owed/i);
				assert.equal(provider.requests.length, 1, "stale continue on posed problem must not start a phantom 2nd LLM call");
				assert.equal(isTurnRunning(chat.id), false);

				// 3. Appending problem-dismissed + sending { type: "continue" } still succeeds
				const current = chatStore.getChat(chat.id)!;
				chatStore.saveMessages(chat.id, [...current.messages, newProblemDismissedMarker("call_p1")]);
				const dismissedContinueRes = await handleChatRequest(
					new Request("http://127.0.0.1/api/chat", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ chatId: chat.id, input: { type: "continue" } }),
					}),
				);
				assert.equal(dismissedContinueRes.status, 200);
				await dismissedContinueRes.arrayBuffer();
				await waitFor(() => !isTurnRunning(chat.id) && !runningTurn(chat.id), 45_000, "dismissed continue settled");
				assert.equal(provider.requests.length, 2);
				const finalMessages = chatStore.getChat(chat.id)!.messages;
				assert.ok(JSON.stringify(finalMessages).includes("Problem dismissed, moving on."));
			} finally {
				runningTurn(chat.id)?.abort();
				await waitFor(() => !isTurnRunning(chat.id) && !runningTurn(chat.id), 30_000, "practice cleanup").catch(() => {});
			}
		} finally {
			await provider.close();
		}
	});
});
