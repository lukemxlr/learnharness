import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, describe, it } from "node:test";
import {
	MIGRATION_BUNDLE_FORMAT_VERSION,
	canonicalJsonString,
	classifyMigrationPath,
	effectiveChatModifiedAt,
	isValidBundleRelativePath,
	isWindowsFileAccessFolder,
	parseMigrationBundleManifest,
	sanitizeFileAccessSettingsForPlatform,
} from "../src/core/contracts/migration.ts";

// Isolated store root BEFORE importing ANY config-loading server/store module
const ISOLATED_STORE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "lh-mig-store-"));
const ISOLATED_DATA_DIR = path.join(ISOLATED_STORE_ROOT, "data");
const ISOLATED_AUTH_FILE = path.join(ISOLATED_STORE_ROOT, "auth.json");
fs.mkdirSync(ISOLATED_DATA_DIR, { recursive: true });
fs.writeFileSync(ISOLATED_AUTH_FILE, "{}\n", "utf8");

const priorEnv = {
	LH_DATA_DIR: process.env.LH_DATA_DIR,
	LH_AUTH_FILE: process.env.LH_AUTH_FILE,
};
process.env.LH_DATA_DIR = ISOLATED_DATA_DIR;
process.env.LH_AUTH_FILE = ISOLATED_AUTH_FILE;

const { SETTINGS_FILE } = await import("../config.ts");
const { readAttachmentBytes } = await import("../src/server/attachments.ts");
const { exportProfile, importProfile, planProfileImport } = await import("../src/server/migration.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { readFileAccessSettings, readSettings } = await import("../src/store/settings.ts");

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const LEGACY_WINDOWS_FIXTURE = path.join(REPO_ROOT, "tests", "fixtures", "synthetic-profile", "legacy-windows");

const PNG_1X1 = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
	"base64",
);
const PNG_1X1_SHA = createHash("sha256").update(PNG_1X1).digest("hex");

const tempDirs: string[] = [];
function mkTempDir(prefix = "lh-mig-test-"): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function copyDirRecursive(src: string, dest: string): void {
	fs.mkdirSync(dest, { recursive: true });
	for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
		const s = path.join(src, entry.name);
		const d = path.join(dest, entry.name);
		if (entry.isDirectory()) copyDirRecursive(s, d);
		else if (entry.isFile()) fs.copyFileSync(s, d);
	}
}

function snapshotTreeDigests(root: string): Map<string, string> {
	const out = new Map<string, string>();
	const walk = (dir: string, prefix: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full, rel);
			else if (entry.isFile()) out.set(rel, createHash("sha256").update(fs.readFileSync(full)).digest("hex"));
		}
	};
	walk(root, "");
	return out;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
	}
});

after(() => {
	for (const [k, v] of Object.entries(priorEnv)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	fs.rmSync(ISOLATED_STORE_ROOT, { recursive: true, force: true });
});

describe("M2 Pure Migration Contracts", () => {
	it("classifies Windows, UNC, POSIX, home-relative, relative, and attachment URLs", () => {
		assert.equal(isWindowsFileAccessFolder("C:\\Users\\Synth\\Notes"), true);
		assert.equal(isWindowsFileAccessFolder("D:/Study"), true);
		assert.equal(isWindowsFileAccessFolder("\\\\nas\\study"), true);
		assert.equal(isWindowsFileAccessFolder("/srv/synth/notes"), false);
		assert.equal(isWindowsFileAccessFolder("~/Notes"), false);
		assert.equal(isWindowsFileAccessFolder("relative/path"), false);

		assert.equal(classifyMigrationPath("C:\\Users\\Synth\\a.png"), "windows_drive");
		assert.equal(classifyMigrationPath("\\\\nas\\study\\doc.pdf"), "unc");
		assert.equal(classifyMigrationPath("/srv/synth/notes"), "posix");
		assert.equal(classifyMigrationPath("~/Notes"), "home_relative");
		assert.equal(classifyMigrationPath("notes/sketch.png"), "relative");
		assert.equal(classifyMigrationPath(`/api/attachments/${PNG_1X1_SHA}`), "attachment_url");

		assert.equal(isValidBundleRelativePath("chats/c1.json"), true);
		assert.equal(isValidBundleRelativePath("../etc/passwd"), false);
		assert.equal(isValidBundleRelativePath("chats\\c1.json"), false);
		assert.equal(isValidBundleRelativePath("C:/chats/c1.json"), false);
		assert.equal(isValidBundleRelativePath("/chats/c1.json"), false);
		assert.equal(isValidBundleRelativePath("chats/bad\x00.json"), false);
	});

	it("sanitizes Windows fileAccess.folders on Linux while preserving restricted flag and POSIX folders", () => {
		const sanitized = sanitizeFileAccessSettingsForPlatform(
			{ restricted: true, folders: ["C:\\Users\\Synth\\Notes", "\\\\nas\\study", "/srv/synth/notes", "~/Study"] },
			"linux",
		);
		assert.deepEqual(sanitized.settings, { restricted: true, folders: ["/srv/synth/notes", "~/Study"] });
		assert.deepEqual(sanitized.removedWindowsFolders, ["C:\\Users\\Synth\\Notes", "\\\\nas\\study"]);

		const onWin = sanitizeFileAccessSettingsForPlatform(
			{ restricted: true, folders: ["C:\\Users\\Synth\\Notes", "/srv/synth/notes"] },
			"win32",
		);
		assert.deepEqual(onWin.settings, { restricted: true, folders: ["C:\\Users\\Synth\\Notes", "/srv/synth/notes"] });
		assert.deepEqual(onWin.removedWindowsFolders, []);
	});

	it("computes effectiveChatModifiedAt across all nested timestamps and canonicalJsonString deterministically", () => {
		const ts = effectiveChatModifiedAt({
			id: "c1",
			title: "T",
			createdAt: "2026-11-01T00:00:00.000Z",
			updatedAt: "2026-11-01T01:00:00.000Z",
			messages: [],
			sideChats: [
				{
					id: "s1",
					anchor: { messageId: "m1", partId: "m1-t0", blockIndex: 0, blockText: "x" },
					open: false,
					createdAt: "2026-11-01T02:00:00.000Z",
					messages: [{ id: "sm1", role: "user", text: "?", at: "2026-11-01T03:00:00.000Z" }],
				},
			],
		});
		assert.equal(ts, "2026-11-01T03:00:00.000Z");
		assert.equal(canonicalJsonString({ b: 2, a: 1, c: undefined }), canonicalJsonString({ a: 1, b: 2 }));
	});
});

describe("M2 Store Hardening (chats modifiedAt & settings Linux fileAccess)", () => {
	it("bumps modifiedAt on all 9 chat mutators while keeping updatedAt pinned on non-message writes and stripped in listChats()", async () => {
		const chat = chatStore.createChat("ModifiedAt Test");
		assert.ok((chat as { modifiedAt?: string }).modifiedAt);
		const listed = chatStore.listChats().find((c) => c.id === chat.id);
		assert.ok(listed);
		assert.equal("modifiedAt" in listed, false, "ChatSummary must not expose modifiedAt");

		const waitTick = () => new Promise((r) => setTimeout(r, 5));
		const getMod = () => (chatStore.getChat(chat.id) as { modifiedAt?: string }).modifiedAt!;

		let prevMod = getMod();
		const pinnedUpdatedAt = chat.updatedAt;

		await waitTick();
		chatStore.renameChat(chat.id, "Renamed");
		assert.equal(chatStore.getChat(chat.id)!.updatedAt, pinnedUpdatedAt);
		assert.ok(getMod() > prevMod, "renameChat bumps modifiedAt");
		prevMod = getMod();

		await waitTick();
		chatStore.saveSettings(chat.id, { model: { provider: "custom", id: "m1" } });
		assert.equal(chatStore.getChat(chat.id)!.updatedAt, pinnedUpdatedAt);
		assert.ok(getMod() > prevMod, "saveSettings bumps modifiedAt");
		prevMod = getMod();

		await waitTick();
		chatStore.saveTree(chat.id, { version: 1, nodes: [{ id: "n1", title: "Node" }], edges: [] });
		assert.equal(chatStore.getChat(chat.id)!.updatedAt, pinnedUpdatedAt);
		assert.ok(getMod() > prevMod, "saveTree bumps modifiedAt");
		prevMod = getMod();

		await waitTick();
		chatStore.updateSideChats(chat.id, () => [
			{
				id: "sc_1",
				anchor: { messageId: "m1", partId: "m1-t0", blockIndex: 0, blockText: "x" },
				open: true,
				createdAt: new Date().toISOString(),
				messages: [],
			},
		]);
		assert.equal(chatStore.getChat(chat.id)!.updatedAt, pinnedUpdatedAt);
		assert.ok(getMod() > prevMod, "updateSideChats bumps modifiedAt");
		prevMod = getMod();

		await waitTick();
		chatStore.saveImageSnapshot(chat.id, PNG_1X1_SHA, {
			mimeType: "image/png",
			data: PNG_1X1.toString("base64"),
			width: 1,
			height: 1,
		});
		assert.equal(chatStore.getChat(chat.id)!.updatedAt, pinnedUpdatedAt);
		assert.ok(getMod() > prevMod, "saveImageSnapshot bumps modifiedAt");
		prevMod = getMod();

		await waitTick();
		chatStore.appendTurnUsage(chat.id, {
			id: "turn_1",
			messageId: "m1",
			at: new Date().toISOString(),
			model: "custom:m1",
			steps: [],
		});
		assert.equal(chatStore.getChat(chat.id)!.updatedAt, pinnedUpdatedAt);
		assert.ok(getMod() > prevMod, "appendTurnUsage bumps modifiedAt");
		prevMod = getMod();

		await waitTick();
		chatStore.appendExtractionUsage(chat.id, {
			startedAt: Date.now(),
			at: new Date().toISOString(),
			durationMs: 10,
			stages: {
				extractor: { model: "custom:m1", steps: [] },
				auditor: { model: "custom:m1", steps: [] },
			},
		});
		assert.equal(chatStore.getChat(chat.id)!.updatedAt, pinnedUpdatedAt);
		assert.ok(getMod() > prevMod, "appendExtractionUsage bumps modifiedAt");
		prevMod = getMod();

		await waitTick();
		chatStore.saveMessages(chat.id, []);
		assert.ok(chatStore.getChat(chat.id)!.updatedAt > pinnedUpdatedAt, "saveMessages bumps updatedAt");
		assert.ok(getMod() > prevMod, "saveMessages bumps modifiedAt");
	});

	it("settingsStore strips Windows drive/UNC fileAccess.folders on Linux while failing closed on relative paths", () => {
		fs.writeFileSync(
			SETTINGS_FILE,
			JSON.stringify({
				version: 1,
				agent: {
					fileAccess: {
						restricted: true,
						folders: ["C:\\Users\\Synth\\Notes", "\\\\nas\\study", "/srv/synth/notes"],
					},
				},
			}),
			"utf8",
		);
		const fa = readFileAccessSettings();
		assert.equal(fa.ok, true);
		if (fa.ok) {
			assert.deepEqual(fa.settings, { restricted: true, folders: ["/srv/synth/notes"] });
		}
		const settings = readSettings();
		assert.deepEqual(settings?.agent?.fileAccess, { restricted: true, folders: ["/srv/synth/notes"] });

		// Genuinely relative paths must still fail closed!
		fs.writeFileSync(
			SETTINGS_FILE,
			JSON.stringify({
				version: 1,
				agent: { fileAccess: { restricted: true, folders: ["/srv/synth/notes", "relative"] } },
			}),
			"utf8",
		);
		assert.equal(readFileAccessSettings().ok, false);
	});
});

describe("M2 End-to-End Export, Dry-Run, Apply, Idempotency & Security", () => {
	it("exports legacy-windows profile strictly read-only, excludes secrets & orphans, and reports missing/Windows paths", () => {
		const work = mkTempDir("lh-mig-export-");
		const sourceDir = path.join(work, "source");
		const bundleDir = path.join(work, "bundle");
		copyDirRecursive(LEGACY_WINDOWS_FIXTURE, sourceDir);

		// Add synthetic secret files & debug dir to ensure exporter excludes them
		fs.writeFileSync(path.join(sourceDir, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-synthetic-secret" }));
		fs.writeFileSync(path.join(sourceDir, "user-auth.json"), JSON.stringify({ username: "synth" }));
		fs.writeFileSync(path.join(sourceDir, "chatgpt-credentials.json"), JSON.stringify({ token: "secret" }));
		fs.writeFileSync(path.join(sourceDir, ".env.local"), "SECRET=1\n");
		fs.mkdirSync(path.join(sourceDir, "debug"), { recursive: true });
		fs.writeFileSync(path.join(sourceDir, "debug", "trace.jsonl"), "{}\n");

		const beforeDigests = snapshotTreeDigests(sourceDir);
		const report = exportProfile({
			sourceDir,
			bundleDir,
			sourceFilesRoot: path.join(sourceDir, "source-files"),
			sourceOs: "win32",
		});
		const afterDigests = snapshotTreeDigests(sourceDir);

		assert.deepEqual(afterDigests, beforeDigests, "sourceDir must remain byte-for-byte identical (edges/events untouched)");
		assert.equal(report.manifest.formatVersion, MIGRATION_BUNDLE_FORMAT_VERSION);
		assert.equal(report.manifest.counts.chats, 2);
		assert.equal(report.manifest.counts.attachments, 2, "only the 2 reachable attachments (h1 + h2), never orphan");
		assert.equal(report.skippedOrphans.attachmentIds.length, 1);
		assert.equal(report.skippedOrphans.sourceFiles.length, 1);
		assert.equal(report.skippedOrphans.totalCount, 2);
		assert.ok(report.excludedSecrets.includes("auth.json"));
		assert.ok(report.excludedSecrets.includes("user-auth.json"));
		assert.ok(report.excludedSecrets.includes("chatgpt-credentials.json"));
		assert.ok(report.excludedSecrets.includes(".env.local"));
		assert.ok(report.excludedSecrets.includes("debug"));
		assert.deepEqual(report.legacyLedgers.sort(), ["edges.jsonl", "events.jsonl"]);

		// Verify orphan attachment & orphan source file were NOT copied to bundleDir
		const orphanId = report.skippedOrphans.attachmentIds[0]!;
		assert.equal(fs.existsSync(path.join(bundleDir, "attachments", orphanId)), false);
		assert.equal(fs.existsSync(path.join(bundleDir, "auth.json")), false);
		assert.equal(fs.existsSync(path.join(bundleDir, "user-auth.json")), false);

		// Verify diagnostics include missing file, Windows/UNC paths, and legacy ledgers
		assert.ok(report.diagnostics.some((d) => d.code === "missing_referenced_file" && d.path?.includes("missing.png")));
		assert.ok(report.diagnostics.some((d) => d.code === "windows_path" && d.path?.includes("C:\\Users\\Synth\\Notes")));
		assert.ok(report.diagnostics.some((d) => d.code === "unc_path" && d.path?.includes("\\\\nas\\study")));
		assert.ok(report.diagnostics.some((d) => d.code === "legacy_ledger" && d.location === "graph/edges.jsonl"));

		// Verify manifest parses strictly
		const parsed = parseMigrationBundleManifest(JSON.parse(fs.readFileSync(path.join(bundleDir, "manifest.json"), "utf8")));
		assert.equal(parsed.counts.chats, 2);
	});

	it("--dry-run writes zero bytes to non-existent or existing targetDir and produces full preview", () => {
		const work = mkTempDir("lh-mig-dry-");
		const bundleDir = path.join(work, "bundle");
		const targetAbsent = path.join(work, "target-absent");

		exportProfile({
			sourceDir: LEGACY_WINDOWS_FIXTURE,
			bundleDir,
			sourceFilesRoot: path.join(LEGACY_WINDOWS_FIXTURE, "source-files"),
			sourceOs: "win32",
		});

		const dryAbsent = planProfileImport({ bundleDir, targetDir: targetAbsent, targetPlatform: "linux" });
		assert.equal(dryAbsent.dryRun, true);
		assert.equal(dryAbsent.integrity.valid, true);
		assert.equal(dryAbsent.bytesWrittenToTarget, 0);
		assert.equal(fs.existsSync(targetAbsent), false, "--dry-run must not even mkdir targetDir");
		assert.deepEqual(dryAbsent.chats.create.sort(), ["chat_win_practice_01", "chat_win_teach_01"]);
		assert.equal(dryAbsent.attachments.ingest.length, 2);
		assert.equal(dryAbsent.settings.action, "create");
		assert.deepEqual(dryAbsent.settings.strippedWindowsFolders, ["C:\\Users\\Synth\\Notes", "\\\\nas\\study"]);
		assert.equal(dryAbsent.settings.preservedRestricted, true);
		assert.equal(dryAbsent.graph.nodesAdded, 3);
		assert.equal(dryAbsent.graph.chainsAdded, 1);

		const targetExisting = path.join(work, "target-existing");
		fs.mkdirSync(targetExisting, { recursive: true });
		fs.writeFileSync(path.join(targetExisting, "sentinel.txt"), "keep", "utf8");
		const before = snapshotTreeDigests(targetExisting);
		const dryExisting = importProfile({ bundleDir, targetDir: targetExisting, dryRun: true, targetPlatform: "linux" });
		assert.equal(dryExisting.bytesWrittenToTarget, 0);
		assert.deepEqual(snapshotTreeDigests(targetExisting), before);
	});

	it("--apply imports full profile, is idempotent on repeat, and preserves newer server edits across all mutators", () => {
		const work = mkTempDir("lh-mig-apply-");
		const bundleDir = path.join(work, "bundle");
		const targetDir = path.join(work, "target");

		exportProfile({
			sourceDir: LEGACY_WINDOWS_FIXTURE,
			bundleDir,
			sourceFilesRoot: path.join(LEGACY_WINDOWS_FIXTURE, "source-files"),
			sourceOs: "win32",
		});

		const firstApply = importProfile({ bundleDir, targetDir, dryRun: false, targetPlatform: "linux" });
		assert.equal(firstApply.integrity.valid, true);
		assert.ok(firstApply.bytesWrittenToTarget > 0);
		assert.equal(firstApply.chats.create.length, 2);
		assert.equal(firstApply.attachments.ingest.length, 2);
		assert.equal(firstApply.graph.nodesAdded, 3);
		assert.equal(firstApply.graph.chainsAdded, 1);

		// Verify sanitized settings on Linux target
		const importedSettings = JSON.parse(fs.readFileSync(path.join(targetDir, "settings.json"), "utf8"));
		assert.deepEqual(importedSettings.agent.fileAccess, { restricted: true, folders: ["/srv/synth/notes"] });

		// Verify source timestamps preserved verbatim on chat
		const importedChat = JSON.parse(fs.readFileSync(path.join(targetDir, "chats", "chat_win_teach_01.json"), "utf8"));
		assert.equal(importedChat.updatedAt, "2026-11-05T09:15:00.000Z");
		assert.equal(importedChat.modifiedAt, "2026-11-05T09:16:05.000Z");

		// Verify reachable attachment readable via M1 store
		const att = readAttachmentBytes("5e3d382db4dd83d59aa5742793ad6b7903409e865c83bcbc54835049f043bc15", targetDir);
		assert.ok(att);
		assert.equal(att.bytes.equals(PNG_1X1), true);

		// Repeat --apply must be 100% idempotent (0 bytes written, 0 duplicates)
		const nodesBefore = fs.readFileSync(path.join(targetDir, "graph", "nodes.jsonl"), "utf8");
		const chainsBefore = fs.readFileSync(path.join(targetDir, "graph", "chains.jsonl"), "utf8");
		const secondApply = importProfile({ bundleDir, targetDir, dryRun: false, targetPlatform: "linux" });
		assert.equal(secondApply.bytesWrittenToTarget, 0);
		assert.equal(secondApply.chats.create.length, 0);
		assert.equal(secondApply.chats.update.length, 0);
		assert.equal(secondApply.chats.skipUnchanged.length, 2);
		assert.equal(secondApply.attachments.ingest.length, 0);
		assert.equal(secondApply.attachments.alreadyPresent.length, 2);
		assert.equal(secondApply.graph.nodesAdded, 0);
		assert.equal(secondApply.graph.chainsAdded, 0);
		assert.equal(secondApply.settings.action, "skip_unchanged");
		assert.equal(fs.readFileSync(path.join(targetDir, "graph", "nodes.jsonl"), "utf8"), nodesBefore);
		assert.equal(fs.readFileSync(path.join(targetDir, "graph", "chains.jsonl"), "utf8"), chainsBefore);

		// Simulate newer server mutations on chat (via modifiedAt / rename / sideChats), positions, sources, settings
		const serverTeach = JSON.parse(fs.readFileSync(path.join(targetDir, "chats", "chat_win_teach_01.json"), "utf8"));
		serverTeach.title = "Server Renamed Title";
		serverTeach.modifiedAt = "2026-11-19T12:00:00.000Z";
		fs.writeFileSync(path.join(targetDir, "chats", "chat_win_teach_01.json"), JSON.stringify(serverTeach, null, "\t"), "utf8");

		const serverPos = JSON.parse(fs.readFileSync(path.join(targetDir, "graph", "positions.json"), "utf8"));
		serverPos.positions.n_win_right_angle = { x: 999, y: 999 };
		serverPos.updatedAt = "2026-11-19T12:00:00.000Z";
		fs.writeFileSync(path.join(targetDir, "graph", "positions.json"), JSON.stringify(serverPos, null, "\t"), "utf8");

		const serverSettings = JSON.parse(fs.readFileSync(path.join(targetDir, "settings.json"), "utf8"));
		serverSettings.appearance = { theme: "catppuccin-latte" };
		fs.writeFileSync(path.join(targetDir, "settings.json"), JSON.stringify(serverSettings, null, "\t"), "utf8");

		const thirdApply = importProfile({ bundleDir, targetDir, dryRun: false, targetPlatform: "linux" });
		assert.deepEqual(thirdApply.chats.skipServerNewer, ["chat_win_teach_01"]);
		assert.equal(thirdApply.settings.action, "preserve_server");
		assert.equal(thirdApply.graph.positionsChanged, false);

		const afterTeach = JSON.parse(fs.readFileSync(path.join(targetDir, "chats", "chat_win_teach_01.json"), "utf8"));
		assert.equal(afterTeach.title, "Server Renamed Title");
		const afterPos = JSON.parse(fs.readFileSync(path.join(targetDir, "graph", "positions.json"), "utf8"));
		assert.deepEqual(afterPos.positions.n_win_right_angle, { x: 999, y: 999 });
		const afterSettings = JSON.parse(fs.readFileSync(path.join(targetDir, "settings.json"), "utf8"));
		assert.equal(afterSettings.appearance.theme, "catppuccin-latte");
	});

	it("rejects traversal, symlinks, checksum tampering, polyglot attachments, and bundled secrets before any target write", () => {
		const work = mkTempDir("lh-mig-sec-");
		const baseBundle = path.join(work, "base-bundle");
		exportProfile({
			sourceDir: LEGACY_WINDOWS_FIXTURE,
			bundleDir: baseBundle,
			sourceFilesRoot: path.join(LEGACY_WINDOWS_FIXTURE, "source-files"),
			sourceOs: "win32",
		});

		// 1. Checksum tampering
		const tamperedBundle = path.join(work, "tampered-bundle");
		copyDirRecursive(baseBundle, tamperedBundle);
		fs.appendFileSync(path.join(tamperedBundle, "settings.json"), "\n");
		const target1 = path.join(work, "t1");
		const resTamper = importProfile({ bundleDir: tamperedBundle, targetDir: target1, dryRun: false });
		assert.equal(resTamper.integrity.valid, false);
		assert.equal(resTamper.bytesWrittenToTarget, 0);
		assert.equal(fs.existsSync(target1), false);

		// 2. Traversal in manifest fileChecksums
		const travBundle = path.join(work, "trav-bundle");
		copyDirRecursive(baseBundle, travBundle);
		const mTrav = JSON.parse(fs.readFileSync(path.join(travBundle, "manifest.json"), "utf8"));
		mTrav.fileChecksums["../escape.json"] = PNG_1X1_SHA;
		fs.writeFileSync(path.join(travBundle, "manifest.json"), JSON.stringify(mTrav, null, "\t"));
		const target2 = path.join(work, "t2");
		const resTrav = importProfile({ bundleDir: travBundle, targetDir: target2, dryRun: false });
		assert.equal(resTrav.integrity.valid, false);
		assert.equal(fs.existsSync(target2), false);

		// 3. Symlink inside bundle
		const symBundle = path.join(work, "sym-bundle");
		copyDirRecursive(baseBundle, symBundle);
		const secretOutside = path.join(work, "outside-secret.txt");
		fs.writeFileSync(secretOutside, "secret");
		fs.symlinkSync(secretOutside, path.join(symBundle, "evil-link.txt"));
		const target3 = path.join(work, "t3");
		const resSym = importProfile({ bundleDir: symBundle, targetDir: target3, dryRun: false });
		assert.equal(resSym.integrity.valid, false);
		assert.equal(fs.existsSync(target3), false);

		// 4. Polyglot HTML+%PDF- disguised attachment in bundle
		const polyBundle = path.join(work, "poly-bundle");
		copyDirRecursive(baseBundle, polyBundle);
		const polyBytes = Buffer.from("<!DOCTYPE html><script>alert(1)</script><!-- %PDF-1.4 --></html>");
		const polySha = createHash("sha256").update(polyBytes).digest("hex");
		const polyRel = `attachments/${polySha}/poly.pdf`;
		fs.mkdirSync(path.join(polyBundle, "attachments", polySha), { recursive: true });
		fs.writeFileSync(path.join(polyBundle, polyRel), polyBytes);
		const mPoly = JSON.parse(fs.readFileSync(path.join(polyBundle, "manifest.json"), "utf8"));
		mPoly.fileChecksums[polyRel] = polySha;
		mPoly.attachments.push({
			id: polySha,
			filename: "poly.pdf",
			mimeType: "application/pdf",
			sizeBytes: polyBytes.byteLength,
			createdAt: "2026-11-05T08:00:00.000Z",
			bundlePath: polyRel,
			origins: [],
		});
		fs.writeFileSync(path.join(polyBundle, "manifest.json"), JSON.stringify(mPoly, null, "\t"));
		const target4 = path.join(work, "t4");
		const resPoly = importProfile({ bundleDir: polyBundle, targetDir: target4, dryRun: false });
		assert.equal(resPoly.integrity.valid, false);
		assert.equal(fs.existsSync(target4), false);

		// 5. Bundled secret file (auth.json)
		const secBundle = path.join(work, "sec-bundle");
		copyDirRecursive(baseBundle, secBundle);
		fs.writeFileSync(path.join(secBundle, "auth.json"), "{}");
		const target5 = path.join(work, "t5");
		const resSec = importProfile({ bundleDir: secBundle, targetDir: target5, dryRun: false });
		assert.equal(resSec.integrity.valid, false);
		assert.equal(fs.existsSync(target5), false);
	});

	it("executes scripts/migrate-profile.mjs natively under Node 26 CLI (export, --dry-run, --apply, idempotency, help/errors)", () => {
		const work = mkTempDir("lh-mig-cli-");
		const bundleDir = path.join(work, "cli-bundle");
		const targetDir = path.join(work, "cli-target");
		const cli = path.join(REPO_ROOT, "scripts", "migrate-profile.mjs");

		const helpOut = execFileSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
		assert.match(helpOut, /migrate-profile\.mjs export/);

		assert.throws(
			() => execFileSync(process.execPath, [cli, "import", "--bundle", bundleDir, "--dry-run", "--apply"], { stdio: "pipe" }),
			/Command failed/,
		);

		const expJson = execFileSync(
			process.execPath,
			[
				cli,
				"export",
				"--source",
				LEGACY_WINDOWS_FIXTURE,
				"--out",
				bundleDir,
				"--source-files-root",
				path.join(LEGACY_WINDOWS_FIXTURE, "source-files"),
				"--source-os",
				"win32",
				"--json",
			],
			{ encoding: "utf8" },
		);
		const expReport = JSON.parse(expJson);
		assert.equal(expReport.manifest.counts.chats, 2);

		const dryJson = execFileSync(
			process.execPath,
			[cli, "import", "--bundle", bundleDir, "--target", targetDir, "--dry-run", "--target-platform", "linux", "--json"],
			{ encoding: "utf8" },
		);
		const dryReport = JSON.parse(dryJson);
		assert.equal(dryReport.dryRun, true);
		assert.equal(dryReport.bytesWrittenToTarget, 0);
		assert.equal(fs.existsSync(targetDir), false);

		const applyJson = execFileSync(
			process.execPath,
			[cli, "import", "--bundle", bundleDir, "--target", targetDir, "--apply", "--target-platform", "linux", "--json"],
			{ encoding: "utf8" },
		);
		const applyReport = JSON.parse(applyJson);
		assert.equal(applyReport.dryRun, false);
		assert.ok(applyReport.bytesWrittenToTarget > 0);

		const repeatText = execFileSync(
			process.execPath,
			[cli, "import", "--bundle", bundleDir, "--target", targetDir, "--apply", "--target-platform", "linux"],
			{ encoding: "utf8" },
		);
		assert.match(repeatText, /Bytes written:\s+0/);
	});

	it("rejects symlinked target subdirs/files, prototype-key attachment bypass, and '.'/'..'/'overlong' manifest filenames with 0 writes", () => {
		const work = mkTempDir("lh-mig-iter2-");
		const baseBundle = path.join(work, "base-bundle");
		exportProfile({
			sourceDir: LEGACY_WINDOWS_FIXTURE,
			bundleDir: baseBundle,
			sourceFilesRoot: path.join(LEGACY_WINDOWS_FIXTURE, "source-files"),
			sourceOs: "win32",
		});

		// 1. Target subtree symlinks: chats, jobs, prompts, prompts/shared, themes, settings.json, attachments, attachments/<sha2>
		const subdirCases = ["chats", "jobs", "prompts", "themes", "attachments", "graph"] as const;
		for (const subdir of subdirCases) {
			const target = path.join(work, `t-sym-${subdir}`);
			const outside = path.join(work, `outside-${subdir}`);
			fs.mkdirSync(target, { recursive: true });
			fs.mkdirSync(outside, { recursive: true });
			fs.symlinkSync(outside, path.join(target, subdir));
			const res = importProfile({ bundleDir: baseBundle, targetDir: target, dryRun: false, targetPlatform: "linux" });
			assert.equal(res.integrity.valid, false, `symlinked targetDir/${subdir} must fail integrity`);
			assert.equal(res.bytesWrittenToTarget, 0, `symlinked targetDir/${subdir} must write 0 bytes`);
			assert.deepEqual(fs.readdirSync(outside), [], `external dir for ${subdir} must remain empty`);
			assert.deepEqual(fs.readdirSync(target), [subdir], `targetDir must have zero writes for ${subdir}`);
		}

		// 1b. Nested symlinked prompt subdir (prompts/shared -> outside)
		{
			const sharedBundle = path.join(work, "shared-prompt-bundle");
			copyDirRecursive(baseBundle, sharedBundle);
			const sharedPromptRel = "prompts/shared/01-test.md";
			const sharedPromptBytes = Buffer.from("# Shared test prompt\n", "utf8");
			fs.mkdirSync(path.join(sharedBundle, "prompts", "shared"), { recursive: true });
			fs.writeFileSync(path.join(sharedBundle, sharedPromptRel), sharedPromptBytes);
			const mShared = JSON.parse(fs.readFileSync(path.join(sharedBundle, "manifest.json"), "utf8"));
			mShared.fileChecksums[sharedPromptRel] = createHash("sha256").update(sharedPromptBytes).digest("hex");
			mShared.counts.prompts += 1;
			fs.writeFileSync(path.join(sharedBundle, "manifest.json"), JSON.stringify(mShared, null, "\t"));

			const target = path.join(work, "t-sym-prompts-shared");
			const outside = path.join(work, "outside-prompts-shared");
			fs.mkdirSync(path.join(target, "prompts"), { recursive: true });
			fs.mkdirSync(outside, { recursive: true });
			fs.symlinkSync(outside, path.join(target, "prompts", "shared"));

			const res = importProfile({ bundleDir: sharedBundle, targetDir: target, dryRun: false, targetPlatform: "linux" });
			assert.equal(res.integrity.valid, false);
			assert.equal(res.bytesWrittenToTarget, 0);
			assert.deepEqual(fs.readdirSync(outside), []);
			assert.deepEqual(fs.readdirSync(target), ["prompts"]);
		}

		// 1c. Symlinked targetDir/settings.json
		{
			const target = path.join(work, "t-sym-settings");
			const outsideFile = path.join(work, "outside-settings.json");
			fs.mkdirSync(target, { recursive: true });
			fs.writeFileSync(outsideFile, "ORIGINAL", "utf8");
			fs.symlinkSync(outsideFile, path.join(target, "settings.json"));
			const res = importProfile({ bundleDir: baseBundle, targetDir: target, dryRun: false, targetPlatform: "linux" });
			assert.equal(res.integrity.valid, false);
			assert.equal(res.bytesWrittenToTarget, 0);
			assert.equal(fs.lstatSync(path.join(target, "settings.json")).isSymbolicLink(), true);
			assert.equal(fs.readFileSync(outsideFile, "utf8"), "ORIGINAL");
			assert.deepEqual(fs.readdirSync(target), ["settings.json"]);
		}

		// 1c2. Symlinked targetDir/graph/nodes.jsonl
		{
			const target = path.join(work, "t-sym-graph-nodes");
			const outsideFile = path.join(work, "outside-nodes.jsonl");
			fs.mkdirSync(path.join(target, "graph"), { recursive: true });
			fs.writeFileSync(outsideFile, "ORIGINAL\n", "utf8");
			fs.symlinkSync(outsideFile, path.join(target, "graph", "nodes.jsonl"));
			const res = importProfile({ bundleDir: baseBundle, targetDir: target, dryRun: false, targetPlatform: "linux" });
			assert.equal(res.integrity.valid, false);
			assert.equal(res.bytesWrittenToTarget, 0);
			assert.equal(fs.readFileSync(outsideFile, "utf8"), "ORIGINAL\n");
			assert.deepEqual(fs.readdirSync(path.join(target, "graph")), ["nodes.jsonl"]);
		}

		// 1d. Multi-attachment partial-write protection when second attachments/<sha> is a symlink
		{
			const mBase = JSON.parse(fs.readFileSync(path.join(baseBundle, "manifest.json"), "utf8"));
			assert.equal(mBase.attachments.length, 2);
			const secondSha = mBase.attachments[1].id as string;
			const target = path.join(work, "t-sym-att-sha");
			const outside = path.join(work, "outside-att-sha");
			fs.mkdirSync(path.join(target, "attachments"), { recursive: true });
			fs.mkdirSync(outside, { recursive: true });
			fs.symlinkSync(outside, path.join(target, "attachments", secondSha));

			const res = importProfile({ bundleDir: baseBundle, targetDir: target, dryRun: false, targetPlatform: "linux" });
			assert.equal(res.integrity.valid, false);
			assert.equal(res.bytesWrittenToTarget, 0);
			assert.deepEqual(fs.readdirSync(outside), []);
			assert.deepEqual(fs.readdirSync(path.join(target, "attachments")), [secondSha], "first attachment must NOT be partially written");
			assert.deepEqual(fs.readdirSync(target), ["attachments"]);
		}

		// 2. Prototype-key lookup bypass: manifest.attachments[0].bundlePath = "toString" (absent from fileChecksums)
		{
			const protoBundle = path.join(work, "proto-bundle");
			copyDirRecursive(baseBundle, protoBundle);
			const mProto = JSON.parse(fs.readFileSync(path.join(protoBundle, "manifest.json"), "utf8"));
			mProto.attachments[0].bundlePath = "toString";
			fs.writeFileSync(path.join(protoBundle, "manifest.json"), JSON.stringify(mProto, null, "\t"));
			const target = path.join(work, "t-proto");
			const res = importProfile({ bundleDir: protoBundle, targetDir: target, dryRun: false, targetPlatform: "linux" });
			assert.equal(res.integrity.valid, false);
			assert.equal(res.bytesWrittenToTarget, 0);
			assert.equal(fs.existsSync(target), false);
		}

		// 3. Invalid manifest.attachments[0].filename ("..", ".", and >255 chars) without metaBundlePath
		for (const badName of ["..", ".", `${"a".repeat(256)}.png`]) {
			const badNameBundle = path.join(work, `bad-name-${badName.length}`);
			copyDirRecursive(baseBundle, badNameBundle);
			const mBad = JSON.parse(fs.readFileSync(path.join(badNameBundle, "manifest.json"), "utf8"));
			mBad.attachments[0].filename = badName;
			delete mBad.attachments[0].metaBundlePath;
			fs.writeFileSync(path.join(badNameBundle, "manifest.json"), JSON.stringify(mBad, null, "\t"));
			const target = path.join(work, `t-bad-name-${badName.length}`);
			const res = importProfile({ bundleDir: badNameBundle, targetDir: target, dryRun: false, targetPlatform: "linux" });
			assert.equal(res.integrity.valid, false, `filename=${badName} must fail manifest validation`);
			assert.equal(res.bytesWrittenToTarget, 0);
			assert.equal(fs.existsSync(target), false);
		}
	});

	it("emits warning diagnostics when referenced sourceFilesRoot files fail MIME sniffing or byte limit, and tolerates stale .tmp-* in --out", () => {
		const work = mkTempDir("lh-mig-export-diag-");
		const sourceDir = path.join(work, "source");
		const filesRoot = path.join(work, "files");
		const bundleDir = path.join(work, "bundle");
		fs.mkdirSync(path.join(sourceDir, "chats"), { recursive: true });
		fs.mkdirSync(filesRoot, { recursive: true });

		// HTML+%PDF- polyglot and >20 MiB PNG referenced by chat
		fs.writeFileSync(path.join(filesRoot, "evil.pdf"), "<html><script>alert(1)</script></html>\n%PDF-1.4\n", "utf8");
		const oversizedPng = Buffer.alloc(20 * 1024 * 1024 + 64, 0);
		PNG_1X1.copy(oversizedPng, 0);
		fs.writeFileSync(path.join(filesRoot, "huge.png"), oversizedPng);

		fs.writeFileSync(
			path.join(sourceDir, "chats", "c_diag.json"),
			JSON.stringify({
				id: "c_diag",
				title: "Diag Test",
				createdAt: "2026-11-10T00:00:00.000Z",
				updatedAt: "2026-11-10T00:00:00.000Z",
				version: 2,
				messages: [
					{
						id: "m1",
						role: "user",
						content: [
							{ type: "text", text: "Check C:\\Notes\\evil.pdf and C:\\Notes\\huge.png" },
						],
						timestamp: 1762732800000,
					},
				],
			}),
			"utf8",
		);

		// Pre-seed stale leftover .tmp-* file in bundleDir to verify randomUUID() temp names don't fail EEXIST
		fs.mkdirSync(path.join(bundleDir, "chats"), { recursive: true });
		fs.writeFileSync(path.join(bundleDir, "chats", "c_diag.json.tmp-stale"), "stale", "utf8");

		const report = exportProfile({
			sourceDir,
			bundleDir,
			sourceFilesRoot: filesRoot,
			sourceOs: "win32",
		});

		assert.equal(report.manifest.counts.attachments, 0);
		assert.ok(
			report.diagnostics.some(
				(d) => d.code === "corrupt_record" && d.severity === "warning" && d.path === "C:\\Notes\\evil.pdf",
			),
			"expected warning diagnostic for MIME-rejected polyglot evil.pdf",
		);
		assert.ok(
			report.diagnostics.some(
				(d) => d.code === "corrupt_record" && d.severity === "warning" && d.path === "C:\\Notes\\huge.png",
			),
			"expected warning diagnostic for oversized huge.png",
		);
	});

	it("handles missing/invalid job updatedAt idempotently, preserves '__proto__' placement keys safely, and tolerates NUL-byte paths on export", () => {
		// 1. Legacy job without updatedAt (idempotent repeat --apply & differing missing-timestamp preservation)
		{
			const work = mkTempDir("lh-mig-job-no-ts-");
			const sourceDir = path.join(work, "source");
			const bundleDir = path.join(work, "bundle");
			const targetDir = path.join(work, "target");
			fs.mkdirSync(path.join(sourceDir, "jobs"), { recursive: true });
			fs.writeFileSync(
				path.join(sourceDir, "jobs", "j_legacy.json"),
				JSON.stringify({
					id: "j_legacy",
					kind: "research",
					chatId: "c1",
					toolCallId: "tc1",
					status: "done",
					activity: "bundle activity",
					createdAt: "2026-11-01T00:00:00.000Z",
				}),
				"utf8",
			);

			exportProfile({ sourceDir, bundleDir, sourceOs: "win32" });

			const first = importProfile({ bundleDir, targetDir, dryRun: false, targetPlatform: "linux" });
			assert.equal(first.integrity.valid, true);
			assert.deepEqual(first.jobs.create, ["j_legacy"]);
			assert.ok(first.bytesWrittenToTarget > 0);

			const second = importProfile({ bundleDir, targetDir, dryRun: false, targetPlatform: "linux" });
			assert.equal(second.integrity.valid, true);
			assert.equal(second.bytesWrittenToTarget, 0, "repeat --apply on legacy job without updatedAt must write 0 bytes");
			assert.deepEqual(second.jobs.skipUnchanged, ["j_legacy"]);
			assert.deepEqual(second.jobs.update, []);

			// Mutate server job without updatedAt -> must be preserved (skipServerNewer, 0 bytes)
			const serverJobPath = path.join(targetDir, "jobs", "j_legacy.json");
			const serverJob = JSON.parse(fs.readFileSync(serverJobPath, "utf8"));
			serverJob.activity = "server edited activity";
			fs.writeFileSync(serverJobPath, JSON.stringify(serverJob, null, "\t"), "utf8");

			const third = importProfile({ bundleDir, targetDir, dryRun: false, targetPlatform: "linux" });
			assert.equal(third.integrity.valid, true);
			assert.equal(third.bytesWrittenToTarget, 0, "differing server job without updatedAt must not be overwritten");
			assert.deepEqual(third.jobs.skipServerNewer, ["j_legacy"]);
			assert.deepEqual(third.jobs.update, []);
			const afterJob = JSON.parse(fs.readFileSync(serverJobPath, "utf8"));
			assert.equal(afterJob.activity, "server edited activity");

			// Invalid unparseable updatedAt on both sides must also be preserved safely
			serverJob.updatedAt = "not-a-valid-date";
			fs.writeFileSync(serverJobPath, JSON.stringify(serverJob, null, "\t"), "utf8");
			const fourth = importProfile({ bundleDir, targetDir, dryRun: false, targetPlatform: "linux" });
			assert.equal(fourth.bytesWrittenToTarget, 0);
			assert.deepEqual(fourth.jobs.skipServerNewer, ["j_legacy"]);
		}

		// 2. graph/source-organization.json with "__proto__" placement key preserved as own property without prototype pollution
		{
			const work = mkTempDir("lh-mig-org-proto-");
			const sourceDir = path.join(work, "source");
			const bundleDir = path.join(work, "bundle");
			const targetDir = path.join(work, "target");
			fs.mkdirSync(path.join(sourceDir, "graph"), { recursive: true });
			fs.mkdirSync(path.join(targetDir, "graph"), { recursive: true });

			fs.writeFileSync(
				path.join(sourceDir, "graph", "source-organization.json"),
				JSON.stringify({
					version: 1,
					folders: [{ id: "f1", name: "Folder", parentId: null, createdAt: "2026-11-01T00:00:00.000Z" }],
					placements: {
						["__proto__"]: { folderId: "f1", name: "Proto Source" },
						src_normal: { folderId: null },
					},
				}),
				"utf8",
			);
			fs.writeFileSync(
				path.join(targetDir, "graph", "source-organization.json"),
				JSON.stringify({
					version: 1,
					folders: [],
					placements: { existing_src: { folderId: null } },
				}),
				"utf8",
			);

			exportProfile({ sourceDir, bundleDir, sourceOs: "linux" });
			const res = importProfile({ bundleDir, targetDir, dryRun: false, targetPlatform: "linux" });
			assert.equal(res.integrity.valid, true);
			assert.equal(res.graph.sourceOrganizationChanged, true);
			assert.equal("folderId" in Object.prototype, false, "Object.prototype must remain unpolluted");
			assert.equal("name" in ({} as Record<string, unknown>), false, "Object.prototype must remain unpolluted");

			const written = JSON.parse(fs.readFileSync(path.join(targetDir, "graph", "source-organization.json"), "utf8"));
			assert.equal(Object.hasOwn(written.placements, "__proto__"), true, "__proto__ placement key must be an own property");
			assert.deepEqual(written.placements["__proto__"], { folderId: "f1", name: "Proto Source" });
			assert.deepEqual(written.placements.existing_src, { folderId: null });
			assert.deepEqual(written.placements.src_normal, { folderId: null });

			const repeat = importProfile({ bundleDir, targetDir, dryRun: false, targetPlatform: "linux" });
			assert.equal(repeat.graph.sourceOrganizationChanged, false);
			assert.equal(repeat.bytesWrittenToTarget, 0);
		}

		// 3. Chat referencing paths containing NUL bytes ("notes\0.png" and "C:\\Notes\\evil\0.png") during exportProfile()
		{
			const work = mkTempDir("lh-mig-nul-export-");
			const sourceDir = path.join(work, "source");
			const bundleDir = path.join(work, "bundle");
			fs.mkdirSync(path.join(sourceDir, "chats"), { recursive: true });
			fs.writeFileSync(
				path.join(sourceDir, "chats", "c_nul.json"),
				JSON.stringify({
					id: "c_nul",
					title: "NUL Path Test",
					createdAt: "2026-11-10T00:00:00.000Z",
					updatedAt: "2026-11-10T00:00:00.000Z",
					version: 2,
					messages: [
						{
							id: "m1",
							role: "assistant",
							content: [
								{ type: "toolCall", id: "tc1", name: "show_image", arguments: { path: "notes\0.png" } },
								{ type: "toolCall", id: "tc2", name: "show_image", arguments: { path: "C:\\Notes\\evil\0.png" } },
							],
							timestamp: 1762732800000,
						},
					],
				}),
				"utf8",
			);

			const report = exportProfile({ sourceDir, bundleDir, sourceOs: "win32" });
			assert.equal(report.manifest.counts.chats, 1);
			assert.equal(report.manifest.counts.attachments, 0);
			assert.ok(
				report.diagnostics.some(
					(d) => d.severity === "warning" && d.code === "corrupt_record" && d.path === "notes\0.png",
				),
				"expected warning diagnostic for relative NUL-byte path",
			);
			assert.ok(
				report.diagnostics.some(
					(d) => d.severity === "warning" && d.code === "corrupt_record" && d.path === "C:\\Notes\\evil\0.png",
				),
				"expected warning diagnostic for Windows NUL-byte path",
			);
		}
	});
});
