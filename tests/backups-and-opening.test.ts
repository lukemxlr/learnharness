import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { after, describe, it } from "node:test";
import { packTarGz, unpackTarGz } from "../src/server/backup-archive.ts";
import {
	createBackupSnapshot,
	deleteBackupSnapshot,
	importBackupArchive,
	importChunkedProfile,
	inspectDataDirCounts,
	listBackupSnapshots,
	readBackupArchive,
	restoreBackupSnapshot,
} from "../src/server/backups.ts";
import { clearOpeningPrompt, readOpeningPromptEntry, stashOpeningPrompt } from "../components/opening-prompt.ts";
import { startDraftSession } from "../components/new-session.tsx";
import type { AttachmentRef } from "../src/core/contracts/attachments.ts";
import { CURRENT_CHAT_VERSION } from "../src/core/contracts/chat.ts";

const require = createRequire(import.meta.url);
const localMigrate = require("../electron/local-migrate.cjs") as {
	inspectLocalDataDir: (dir: string) => { hasData: boolean; counts: { chats: number; flashcards: number; attachments: number } };
	createLocalSafetyCopy: (dataDir: string, userDataDir: string) => string;
	migrateLocalDataToServer: (opts: {
		dataDir: string;
		userDataDir: string;
		serverOrigin: string;
		dryRun?: boolean;
		fetchImpl: typeof fetch;
	}) => Promise<{ ok: boolean; dryRun?: boolean; uploadedAttachments?: number; localBackupPath?: string; preview?: { chatsCreated: number } }>;
};

const tempDirs: string[] = [];
function mkTemp(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

after(() => {
	while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function seedProfile(dataDir: string, opts: { chatTitle: string; chatUpdatedAt: string; cardFront: string }) {
	fs.mkdirSync(path.join(dataDir, "chats"), { recursive: true });
	fs.mkdirSync(path.join(dataDir, "graph"), { recursive: true });
	fs.mkdirSync(path.join(dataDir, "core-plugin-data", "flashcards"), { recursive: true });
	fs.writeFileSync(
		path.join(dataDir, "chats", "c1.json"),
		JSON.stringify({
			version: CURRENT_CHAT_VERSION,
			id: "c1",
			title: opts.chatTitle,
			createdAt: "2026-11-20T10:00:00.000Z",
			updatedAt: opts.chatUpdatedAt,
			modifiedAt: opts.chatUpdatedAt,
			messages: [],
		}),
		"utf8",
	);
	fs.writeFileSync(
		path.join(dataDir, "graph", "format.json"),
		JSON.stringify({ version: 1 }),
		"utf8",
	);
	fs.writeFileSync(
		path.join(dataDir, "graph", "nodes.jsonl"),
		`${JSON.stringify({
			id: "n1",
			name: "Vanillin",
			statement: "Vanillin ist ein Aldehyd.",
			aliases: [],
			createdAt: "2026-11-20T10:00:00.000Z",
			provenance: [{ chatId: "c1", messageId: "m1" }],
		})}\n`,
		"utf8",
	);
	fs.writeFileSync(
		path.join(dataDir, "core-plugin-data", "flashcards", "flashcards.json"),
		JSON.stringify({
			version: 1,
			revision: 1,
			settings: { retention: 0.9, learningSteps: [1, 10], relearningSteps: [10], dayStart: 4, fuzz: false, chunkBudget: 4000, modelOverride: null },
			decks: [{ id: "d1", name: "Chemie", propositionIds: ["n1"] }],
			propositions: {
				n1: {
					id: "n1",
					version: 1,
					cues: [{ id: "cue1", question: opts.cardFront, answer: "Aldehyd" }],
				},
			},
			reviews: [],
			batches: [],
		}),
		"utf8",
	);
	// Secret files that MUST NEVER enter backups
	fs.writeFileSync(path.join(dataDir, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "secret" }), "utf8");
	fs.writeFileSync(path.join(dataDir, "user-auth.json"), JSON.stringify({ passwordHash: "secret" }), "utf8");
}

describe("backup-archive.ts pure-Node .tar.gz", () => {
	it("round-trips ASCII, UTF-8 umlaut, and long (>100 char) paths and rejects unsafe paths", () => {
		const longPath = `prompts/${"nested-segment-".repeat(8)}Übung_ÄÖÜ.md`;
		const gz = packTarGz([
			{ path: "chats/c1.json", bytes: Buffer.from('{"id":"c1"}', "utf8") },
			{ path: longPath, bytes: Buffer.from("Hallo Welt äöüß", "utf8") },
		]);
		const unpacked = unpackTarGz(gz);
		assert.equal(unpacked.length, 2);
		assert.equal(unpacked[0]!.path, "chats/c1.json");
		assert.equal(unpacked[1]!.path, longPath);
		assert.equal(unpacked[1]!.bytes.toString("utf8"), "Hallo Welt äöüß");

		assert.throws(() => packTarGz([{ path: "../escape.txt", bytes: Buffer.from("x") }]), /Invalid archive entry path/);
	});
});

describe("backups.ts snapshots, safety rollback, merge & replace restore", () => {
	it("creates verified backups excluding secrets, auto-saves pre-restore safety snapshot, and rolls back cleanly", () => {
		const dataDir = mkTemp("lh-backups-");
		seedProfile(dataDir, { chatTitle: "Chemie V1", chatUpdatedAt: "2026-11-20T10:00:00.000Z", cardFront: "Card V1" });

		const counts = inspectDataDirCounts(dataDir);
		assert.equal(counts.chats, 1);
		assert.equal(counts.graphNodes, 1);
		assert.equal(counts.flashcards, 1);

		const snap1 = createBackupSnapshot({ dataDir, reason: "manual", label: "Baseline" });
		assert.equal(snap1.counts.chats, 1);
		assert.equal(snap1.counts.flashcards, 1);

		const loaded = readBackupArchive(snap1.id, dataDir);
		assert.ok(loaded);
		const archivePaths = unpackTarGz(loaded.bytes).map((e) => e.path);
		assert.ok(archivePaths.includes("chats/c1.json"));
		assert.ok(archivePaths.includes("core-plugin-data/flashcards/flashcards.json"));
		assert.equal(archivePaths.some((p) => p.includes("auth.json") || p.includes("user-auth.json")), false);

		// Mutate live state to V2
		seedProfile(dataDir, { chatTitle: "Chemie V2", chatUpdatedAt: "2026-11-21T10:00:00.000Z", cardFront: "Card V2" });
		assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, "chats", "c1.json"), "utf8")).title, "Chemie V2");

		// Restore V1 -> must create an automatic pre-restore safety snapshot of V2 FIRST
		const restored = restoreBackupSnapshot({ id: snap1.id, dataDir, mode: "replace", dryRun: false });
		assert.ok(restored.safetyBackup, "must create automatic pre-restore safety snapshot");
		assert.equal(restored.safetyBackup.reason, "pre-restore");
		assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, "chats", "c1.json"), "utf8")).title, "Chemie V1");

		// Roll back to the automatic safety snapshot -> V2 is back!
		restoreBackupSnapshot({ id: restored.safetyBackup.id, dataDir, mode: "replace", dryRun: false });
		assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, "chats", "c1.json"), "utf8")).title, "Chemie V2");
		assert.ok(listBackupSnapshots(dataDir).length >= 3);
		assert.equal(deleteBackupSnapshot(snap1.id, dataDir), true);
	});

	it("supports dry-run 0-byte preview and chunked/archive merge preserving newer server records", () => {
		const srcDir = mkTemp("lh-mig-src-");
		const targetDir = mkTemp("lh-mig-dst-");
		seedProfile(srcDir, { chatTitle: "Local Chat", chatUpdatedAt: "2026-11-20T10:00:00.000Z", cardFront: "Local Card" });
		const snap = createBackupSnapshot({ dataDir: srcDir, reason: "manual" });
		const archive = readBackupArchive(snap.id, srcDir)!.bytes;

		const dry = importBackupArchive({ archiveBytes: archive, dataDir: targetDir, mode: "merge", dryRun: true });
		assert.equal(dry.dryRun, true);
		assert.equal(dry.bytesWritten, 0);
		assert.equal(dry.chatsCreated, 1);
		assert.equal(fs.existsSync(path.join(targetDir, "chats", "c1.json")), false);

		const applied = importBackupArchive({ archiveBytes: archive, dataDir: targetDir, mode: "merge", dryRun: false });
		assert.equal(applied.chatsCreated, 1);
		assert.ok(applied.safetyBackup);
		assert.equal(fs.existsSync(path.join(targetDir, "chats", "c1.json")), true);
		assert.equal(fs.existsSync(path.join(targetDir, "core-plugin-data", "flashcards", "flashcards.json")), true);

		// Chunked JSON import (Electron 1-click migration seam) + Flashcards v1 multi-deck merge
		const chunkedTarget = mkTemp("lh-chunk-dst-");
		seedProfile(chunkedTarget, { chatTitle: "Existing Server Chat", chatUpdatedAt: "2026-11-22T10:00:00.000Z", cardFront: "Existing Card" });
		// Add a second distinct proposition + deck in srcDir so merge must union both
		const srcFc = JSON.parse(fs.readFileSync(path.join(srcDir, "core-plugin-data", "flashcards", "flashcards.json"), "utf8"));
		srcFc.decks.push({ id: "d2", name: "Physik", propositionIds: ["n2"] });
		srcFc.propositions.n2 = { id: "n2", version: 1, cues: [{ id: "cue2", question: "F = m * a?", answer: "Newton 2" }] };
		fs.writeFileSync(path.join(srcDir, "core-plugin-data", "flashcards", "flashcards.json"), JSON.stringify(srcFc), "utf8");

		const chunkRes = importChunkedProfile({
			dataDir: chunkedTarget,
			mode: "merge",
			dryRun: false,
			files: [
				{
					path: "chats/c1.json",
					contentBase64: fs.readFileSync(path.join(srcDir, "chats", "c1.json")).toString("base64"),
				},
				{
					path: "core-plugin-data/flashcards/flashcards.json",
					contentBase64: fs.readFileSync(path.join(srcDir, "core-plugin-data", "flashcards", "flashcards.json")).toString("base64"),
				},
			],
		});
		// Server chat is newer (2026-11-22 > 2026-11-20), so c1 must be skipped (preserved), while Flashcards merges n2 + deck d2!
		assert.equal(chunkRes.chatsCreated, 0);
		assert.equal(chunkRes.chatsSkipped, 1);
		assert.equal(chunkRes.flashcardsRestored, 1);
		assert.equal(chunkRes.safetyBackup?.reason, "pre-migration");
		const mergedFc = JSON.parse(fs.readFileSync(path.join(chunkedTarget, "core-plugin-data", "flashcards", "flashcards.json"), "utf8"));
		assert.ok(mergedFc.propositions.n1 && mergedFc.propositions.n2, "both existing and incoming propositions must survive merge");
		assert.equal(mergedFc.decks.length, 2, "both existing and incoming decks must survive merge");
	});
});

describe("electron/local-migrate.cjs", () => {
	it("inspects local data, saves an automatic local safety copy, and migrates via chunked endpoints", async () => {
		const userData = mkTemp("lh-el-mig-");
		const dataDir = path.join(userData, "data");
		seedProfile(dataDir, { chatTitle: "Desktop Session", chatUpdatedAt: "2026-11-22T10:00:00.000Z", cardFront: "Card A" });

		const summary = localMigrate.inspectLocalDataDir(dataDir);
		assert.equal(summary.hasData, true);
		assert.equal(summary.counts.chats, 1);
		assert.equal(summary.counts.flashcards, 1);

		const calls: string[] = [];
		const fakeFetch = (async (url: string | URL) => {
			const u = String(url);
			calls.push(u);
			if (u.endsWith("/api/auth/session")) {
				return new Response(JSON.stringify({ authRequired: true, authenticated: true, username: "Luke" }), { status: 200 });
			}
			if (u.endsWith("/api/backups/import")) {
				return new Response(JSON.stringify({ dryRun: false, chatsCreated: 1, chatsUpdated: 0, chatsSkipped: 0 }), { status: 200 });
			}
			return new Response("not found", { status: 404 });
		}) as unknown as typeof fetch;

		const res = await localMigrate.migrateLocalDataToServer({
			dataDir,
			userDataDir: userData,
			serverOrigin: "https://server.example.test",
			dryRun: false,
			fetchImpl: fakeFetch,
		});
		assert.equal(res.ok, true);
		assert.ok(res.localBackupPath && fs.existsSync(path.join(res.localBackupPath, "chats", "c1.json")));
		assert.equal(res.preview?.chatsCreated, 1);
		assert.ok(calls.some((c) => c.endsWith("/api/backups/import")));
	});
});

describe("new-session opening prompt attachments (Ctrl+V & upload)", () => {
	it("stashes and restores opening attachments both with text and attachment-only", async () => {
		const mem = new Map<string, string>();
		const prev = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
		Object.defineProperty(globalThis, "sessionStorage", {
			configurable: true,
			value: {
				getItem: (k: string) => mem.get(k) ?? null,
				setItem: (k: string, v: string) => { mem.set(k, v); },
				removeItem: (k: string) => { mem.delete(k); },
			},
		});
		try {
			const att: AttachmentRef = {
				id: "a".repeat(64),
				kind: "image",
				filename: "screenshot.png",
				mimeType: "image/png",
				sizeBytes: 1234,
				url: `/api/attachments/${"a".repeat(64)}`,
			};
			assert.equal(stashOpeningPrompt("c_att", "", false, [att]), true);
			const entry = readOpeningPromptEntry("c_att");
			assert.deepEqual(entry, { text: "", attempted: false, attachments: [att] });
			clearOpeningPrompt("c_att");

			let sentBody: unknown = null;
			const fakeFetch = (async (_url: string | URL, init?: RequestInit) => {
				sentBody = JSON.parse(String(init?.body));
				return new Response(JSON.stringify({ id: "c_img_only" }), { status: 201 });
			}) as unknown as typeof fetch;

			const target = await startDraftSession("", fakeFetch, undefined, undefined, undefined, undefined, [att]);
			assert.equal(target, "/chat/c_img_only");
			assert.deepEqual(sentBody, { title: "screenshot.png" });
			assert.deepEqual(readOpeningPromptEntry("c_img_only"), { text: "", attempted: false, attachments: [att] });
		} finally {
			if (prev) Object.defineProperty(globalThis, "sessionStorage", prev);
			else Reflect.deleteProperty(globalThis, "sessionStorage");
		}
	});
});
