import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import type { ChatRecord, SideChatThread } from "../src/core/contracts.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import { createSideChatService } from "../src/server/side-chat.ts";
import type { ChatStore } from "../src/core/ports.ts";
import { ServerEventsProvider, type NotifySource } from "../components/server-events.tsx";
import { useSideThread } from "../components/use-side-thread.ts";

test("side-chat server emits NDJSON ping heartbeats with X-Accel-Buffering: no and clears timer on cancel/done", async () => {
	let release!: () => void;
	const gate = new Promise<void>((r) => { release = r; });
	let aborted = false;

	const record: ChatRecord & { sideChats: SideChatThread[] } = {
		id: "chat_side_ping",
		title: "Side ping",
		createdAt: "2026-11-19T00:00:00Z",
		updatedAt: "2026-11-19T00:00:00Z",
		messages: [{ ...fauxAssistantMessage([fauxText("Teaching segment.")]), id: "seg_1" }] as unknown as LhMessage[],
		sideChats: [],
	};

	const store = {
		getChat: (id: string) => (id === record.id ? record : null),
		updateSideChats: (id: string, fn: (threads: SideChatThread[]) => SideChatThread[]) => {
			if (id !== record.id) return null;
			record.sideChats = fn(record.sideChats);
			return record.sideChats;
		},
		appendTurnUsage() {},
	} as unknown as ChatStore;

	const service = createSideChatService({
		chatStore: store,
		heartbeatMs: 15,
		instructions: () => "Helper",
		engineFor: async () => ({
			model: { id: "m", provider: "custom", api: "openai-completions", contextWindow: 128_000, maxTokens: 4096 } as never,
			streamFn: (_model, _ctx, opts) => {
				const stream = createAssistantMessageEventStream();
				opts?.signal?.addEventListener("abort", () => { aborted = true; });
				void (async () => {
					stream.push({ type: "start", partial: fauxAssistantMessage([]) });
					stream.push({ type: "text_delta", contentIndex: 0, delta: "Working ", partial: fauxAssistantMessage([fauxText("Working ")]) });
					await gate;
					const finalMsg = fauxAssistantMessage([fauxText("Working done.")]);
					stream.push({ type: "text_delta", contentIndex: 0, delta: "done.", partial: finalMsg });
					stream.push({ type: "done", reason: "stop", message: finalMsg });
					stream.end();
				})();
				return stream;
			},
		}),
	});

	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	let watchReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	try {
		const res = await service.ask(record.id, {
			anchor: { messageId: "seg_1", partId: "seg_1-t0", blockIndex: 0, blockText: "Teaching segment." },
			text: "Explain?",
			quotes: [],
		});
		assert.equal(res.status, 200);
		assert.equal(res.headers.get("x-accel-buffering"), "no");
		assert.ok(res.headers.get("cache-control")?.includes("no-cache"));

		reader = res.body!.getReader();
		const decoder = new TextDecoder();
		let buf = "";
		while (!buf.includes('"type":"ping"')) {
			const { done, value } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
		}
		assert.ok(buf.includes('{"type":"ping"}\n'), "expected NDJSON ping frame");

		// Attach a second watcher, then cancel first watcher (must not abort run)
		const watchRes = service.watch(record.id, record.sideChats[0]!.id);
		assert.equal(watchRes.headers.get("x-accel-buffering"), "no");
		watchReader = watchRes.body!.getReader();
		await reader.cancel();
		assert.equal(aborted, false, "cancelling one NDJSON view must not abort side answer");

		let watchBuf = "";
		while (!watchBuf.includes('"type":"ping"')) {
			const { done, value } = await watchReader.read();
			if (done) break;
			watchBuf += decoder.decode(value, { stream: true });
		}
		release();
		for (;;) {
			const { done, value } = await watchReader.read();
			if (done) break;
			watchBuf += decoder.decode(value, { stream: true });
		}
		const events = watchBuf.trim().split("\n").map((line) => JSON.parse(line) as { type: string });
		assert.ok(events.some((e) => e.type === "ping"));
		assert.equal(events.at(-1)?.type, "done");
	} finally {
		release();
		service.stopAll(record.id);
		await reader?.cancel().catch(() => {});
		await watchReader?.cancel().catch(() => {});
		if (record.sideChats[0]?.id) {
			await service.settled(record.id, record.sideChats[0].id).catch(() => {});
		}
	}
});

test("side-chat honors LH_STREAM_KEEPALIVE_MS when deps.heartbeatMs is omitted and allows explicit 0 override", async () => {
	const prevEnv = process.env.LH_STREAM_KEEPALIVE_MS;
	const makeFixture = (heartbeatMs?: number) => {
		let release!: () => void;
		const gate = new Promise<void>((r) => { release = r; });
		const record: ChatRecord & { sideChats: SideChatThread[] } = {
			id: "chat_side_env_ping",
			title: "Side env ping",
			createdAt: "2026-11-19T00:00:00Z",
			updatedAt: "2026-11-19T00:00:00Z",
			messages: [{ ...fauxAssistantMessage([fauxText("Teaching segment.")]), id: "seg_1" }] as unknown as LhMessage[],
			sideChats: [],
		};
		const store = {
			getChat: (id: string) => (id === record.id ? record : null),
			updateSideChats: (id: string, fn: (threads: SideChatThread[]) => SideChatThread[]) => {
				if (id !== record.id) return null;
				record.sideChats = fn(record.sideChats);
				return record.sideChats;
			},
			appendTurnUsage() {},
		} as unknown as ChatStore;
		const service = createSideChatService({
			chatStore: store,
			...(heartbeatMs !== undefined ? { heartbeatMs } : {}),
			instructions: () => "Helper",
			engineFor: async () => ({
				model: { id: "m", provider: "custom", api: "openai-completions", contextWindow: 128_000, maxTokens: 4096 } as never,
				streamFn: () => {
					const stream = createAssistantMessageEventStream();
					void (async () => {
						stream.push({ type: "start", partial: fauxAssistantMessage([]) });
						await gate;
						const finalMsg = fauxAssistantMessage([fauxText("Done.")]);
						stream.push({ type: "text_delta", contentIndex: 0, delta: "Done.", partial: finalMsg });
						stream.push({ type: "done", reason: "stop", message: finalMsg });
						stream.end();
					})();
					return stream;
				},
			}),
		});
		return { record, service, release: () => release() };
	};

	try {
		process.env.LH_STREAM_KEEPALIVE_MS = "60";
		const f1 = makeFixture(undefined);
		let r1: ReadableStreamDefaultReader<Uint8Array> | undefined;
		try {
			const res = await f1.service.ask(f1.record.id, {
				anchor: { messageId: "seg_1", partId: "seg_1-t0", blockIndex: 0, blockText: "Teaching segment." },
				text: "Ping?",
				quotes: [],
			});
			r1 = res.body!.getReader();
			const decoder = new TextDecoder();
			let buf = "";
			while (!buf.includes('"type":"ping"')) {
				const { done, value } = await r1.read();
				if (done) break;
				buf += decoder.decode(value, { stream: true });
			}
			assert.ok(buf.includes('{"type":"ping"}\n'), "expected env-configured NDJSON ping");
		} finally {
			f1.release();
			f1.service.stopAll(f1.record.id);
			await r1?.cancel().catch(() => {});
			if (f1.record.sideChats[0]?.id) {
				await f1.service.settled(f1.record.id, f1.record.sideChats[0].id).catch(() => {});
			}
		}

		// Explicit heartbeatMs: 0 overrides LH_STREAM_KEEPALIVE_MS
		const f2 = makeFixture(0);
		let r2: ReadableStreamDefaultReader<Uint8Array> | undefined;
		try {
			const res = await f2.service.ask(f2.record.id, {
				anchor: { messageId: "seg_1", partId: "seg_1-t0", blockIndex: 0, blockText: "Teaching segment." },
				text: "No ping?",
				quotes: [],
			});
			r2 = res.body!.getReader();
			await new Promise((r) => setTimeout(r, 120));
			f2.release();
			const decoder = new TextDecoder();
			let buf = "";
			for (;;) {
				const { done, value } = await r2.read();
				if (done) break;
				buf += decoder.decode(value, { stream: true });
			}
			assert.equal(buf.includes('"type":"ping"'), false, "explicit heartbeatMs: 0 must disable pings despite env");
		} finally {
			f2.release();
			f2.service.stopAll(f2.record.id);
			await r2?.cancel().catch(() => {});
			if (f2.record.sideChats[0]?.id) {
				await f2.service.settled(f2.record.id, f2.record.sideChats[0].id).catch(() => {});
			}
		}
	} finally {
		if (prevEnv === undefined) delete process.env.LH_STREAM_KEEPALIVE_MS;
		else process.env.LH_STREAM_KEEPALIVE_MS = prevEnv;
	}
});

test("useSideThread safely ignores chunk-split NDJSON ping lines on POST and GET watch streams", async () => {
	const { document, window } = parseHTML("<html><body><div id='root'></div></body></html>");
	const source: NotifySource = { close() {}, onOpen() {}, onEvent() {} };
	const thread = {
		id: "side_seg_1",
		anchor: { messageId: "seg_1", partId: "seg_1-t0", blockIndex: 0, blockText: "Segment" },
		open: true,
		createdAt: "2026-11-19T00:00:00Z",
		messages: [{ id: "q1", role: "user" as const, text: "Why?", at: "2026-11-19T00:00:00Z" }],
	};

	const chunkedNdjson = (lines: string[]) => {
		const bytes = new TextEncoder().encode(lines.join(""));
		return new ReadableStream<Uint8Array>({
			start(controller) {
				for (let i = 0; i < bytes.length; i += 5) controller.enqueue(bytes.slice(i, i + 5));
				controller.close();
			},
		});
	};

	let mode: "post" | "watch" = "post";
	const fakeFetch: typeof fetch = async (_url, options) => {
		if (options?.method === "POST") {
			mode = "post";
			return new Response(chunkedNdjson([
				`${JSON.stringify({ type: "thread", thread })}\n`,
				'{"type":"ping"}\n',
				`${JSON.stringify({ type: "text", text: "Partial from POST" })}\n`,
				'{"type":"ping"}\n',
				`${JSON.stringify({ type: "done", thread: { ...thread, messages: [...thread.messages, { id: "a1", role: "assistant", text: "Final POST", at: "2026-11-19T00:00:01Z", model: "test" }] } })}\n`,
			]));
		}
		if (String(_url).endsWith(`/side-chats/${thread.id}`)) {
			mode = "watch";
			return new Response(chunkedNdjson([
				`${JSON.stringify({ type: "thread", thread })}\n`,
				'{"type":"ping"}\n',
				`${JSON.stringify({ type: "text", text: "Partial from GET" })}\n`,
				'{"type":"ping"}\n',
				`${JSON.stringify({ type: "done", thread: { ...thread, messages: [...thread.messages, { id: "a2", role: "assistant", text: "Final GET", at: "2026-11-19T00:00:02Z", model: "test" }] } })}\n`,
			]));
		}
		return Response.json({ threads: [thread], answering: { [thread.id]: "Partial from GET" } });
	};

	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [key, value] of Object.entries({ React, document, window, fetch: fakeFetch, IS_REACT_ACT_ENVIRONMENT: true })) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}

	const messages: LhMessage[] = [{ ...fauxAssistantMessage("Segment"), id: "seg_1" } as unknown as LhMessage];
	let side!: ReturnType<typeof useSideThread>;
	function Harness() { side = useSideThread("chat_1", messages); return null; }
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(document.getElementById("root")!);
	try {
		await act(async () => root.render(<ServerEventsProvider connect={() => source}><Harness /></ServerEventsProvider>));
		await act(async () => side.open({ sourceMessageId: "seg_1", anchor: { kind: "composer" } }));
		assert.equal(mode, "watch");
		assert.equal(side.state?.error, undefined);
		assert.equal(side.state?.messages.at(-1)?.text, "Final GET");

		await act(async () => { await side.ask("Follow up"); });
		assert.equal(mode, "post");
		assert.equal(side.state?.error, undefined);
		assert.equal(side.state?.messages.at(-1)?.text, "Final POST");
	} finally {
		await act(async () => root.unmount());
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
		}
	}
});
