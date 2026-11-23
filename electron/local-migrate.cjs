"use strict";

/**
 * Local-to-Server 1-Click Profile Migration Helper (Electron Main Process Only).
 *
 * Strictly reads ONLY the desktop app's fixed local `data/` directory,
 * creates an automatic local safety copy before migrating, uploads binary
 * attachments individually to `POST /api/attachments` (respecting Cloudflare's
 * 100 MiB per-request limit), and sends lightweight JSON metadata to
 * `POST /api/backups/import` (which creates a server-side pre-migration
 * safety snapshot before merging idempotently).
 */

const fs = require("node:fs");
const path = require("node:path");
const { isCloudflareAccessUrl } = require("./remote-config.cjs");

const MANAGED_TOP_DIRS = new Set([
	"chats",
	"jobs",
	"graph",
	"prompts",
	"themes",
	"attachments",
	"core-plugin-data",
]);
const MANAGED_TOP_FILES = new Set(["settings.json", "plugins-state.json"]);
const SHA256_RE = /^[a-f0-9]{64}$/;

function isSecretName(name) {
	const lower = String(name).toLowerCase();
	if (lower === "auth.json") return true;
	if (lower === "user-auth.json" || lower.startsWith("user-auth.json.")) return true;
	if (lower.endsWith("-credentials.json") || /-credentials\.json\./.test(lower)) return true;
	if (lower === ".env" || lower.startsWith(".env.")) return true;
	return false;
}

function emptyCounts() {
	return {
		chats: 0,
		attachments: 0,
		graphNodes: 0,
		graphChains: 0,
		jobs: 0,
		prompts: 0,
		themes: 0,
		flashcards: 0,
	};
}

function countLines(buf) {
	if (!buf) return 0;
	let n = 0;
	for (const line of buf.toString("utf8").split(/\r?\n/)) {
		if (line.trim()) n++;
	}
	return n;
}

function countFlashcards(buf) {
	if (!buf) return 0;
	try {
		const parsed = JSON.parse(buf.toString("utf8"));
		if (Array.isArray(parsed)) return parsed.length;
		if (parsed && typeof parsed === "object") {
			if (parsed.propositions && typeof parsed.propositions === "object" && !Array.isArray(parsed.propositions)) {
				let totalCues = 0;
				const props = Object.values(parsed.propositions);
				for (const p of props) {
					if (p && typeof p === "object" && Array.isArray(p.cues)) {
						totalCues += p.cues.filter((c) => c && !c.deleted).length;
					}
				}
				return totalCues > 0 ? totalCues : props.length;
			}
			if (Array.isArray(parsed.cards)) return parsed.cards.length;
			if (parsed.cards && typeof parsed.cards === "object") return Object.keys(parsed.cards).length;
		}
	} catch { /* ignore */ }
	return 0;
}

function collectLocalFiles(dataDir) {
	const resolved = path.resolve(dataDir);
	if (!fs.existsSync(resolved)) return [];
	const files = [];
	const walk = (absDir, relPrefix) => {
		let dirents;
		try {
			dirents = fs.readdirSync(absDir, { withFileTypes: true });
		} catch {
			return;
		}
		dirents.sort((a, b) => a.name.localeCompare(b.name));
		for (const d of dirents) {
			if (d.isSymbolicLink() || isSecretName(d.name)) continue;
			const rel = relPrefix ? `${relPrefix}/${d.name}` : d.name;
			const abs = path.join(absDir, d.name);
			if (d.isDirectory()) {
				if (!relPrefix && !MANAGED_TOP_DIRS.has(d.name)) continue;
				if (d.name === ".backups" || d.name === "debug") continue;
				walk(abs, rel);
			} else if (d.isFile()) {
				if (!relPrefix && !MANAGED_TOP_FILES.has(d.name)) continue;
				if (rel.startsWith("attachments/") && rel.endsWith(".extracted.json")) continue;
				try {
					const stat = fs.lstatSync(abs);
					if (stat.isSymbolicLink() || !stat.isFile()) continue;
					files.push({ rel, abs, size: stat.size });
				} catch { /* skip */ }
			}
		}
	};
	walk(resolved, "");
	return files;
}

function inspectLocalDataDir(dataDir) {
	const files = collectLocalFiles(dataDir);
	const counts = emptyCounts();
	const attIds = new Set();
	for (const f of files) {
		const p = f.rel;
		if (p.startsWith("chats/") && p.endsWith(".json")) counts.chats++;
		else if (p.startsWith("jobs/") && p.endsWith(".json")) counts.jobs++;
		else if (p.startsWith("prompts/") && p.endsWith(".md")) counts.prompts++;
		else if (p.startsWith("themes/") && p.endsWith(".json")) counts.themes++;
		else if (p === "graph/nodes.jsonl") {
			try { counts.graphNodes = countLines(fs.readFileSync(f.abs)); } catch { /* ignore */ }
		} else if (p === "graph/chains.jsonl") {
			try { counts.graphChains = countLines(fs.readFileSync(f.abs)); } catch { /* ignore */ }
		} else if (p === "core-plugin-data/flashcards/flashcards.json") {
			try { counts.flashcards = countFlashcards(fs.readFileSync(f.abs)); } catch { /* ignore */ }
		} else if (p.startsWith("attachments/")) {
			const parts = p.split("/");
			if (parts.length === 3 && SHA256_RE.test(parts[1])) attIds.add(parts[1]);
		}
	}
	counts.attachments = attIds.size;
	const hasData =
		counts.chats > 0 ||
		counts.graphNodes > 0 ||
		counts.flashcards > 0 ||
		counts.prompts > 0 ||
		counts.themes > 0;
	return { hasData, counts };
}

function createLocalSafetyCopy(dataDir, userDataDir) {
	const files = collectLocalFiles(dataDir);
	const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
	const backupRoot = path.join(userDataDir, "local-backups", `pre-migration-${stamp}`);
	fs.mkdirSync(backupRoot, { recursive: true });
	for (const f of files) {
		const dest = path.join(backupRoot, ...f.rel.split("/"));
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		fs.copyFileSync(f.abs, dest);
	}
	return backupRoot;
}

function guessMimeType(filename) {
	const lower = filename.toLowerCase();
	if (lower.endsWith(".png")) return "image/png";
	if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
	if (lower.endsWith(".webp")) return "image/webp";
	if (lower.endsWith(".gif")) return "image/gif";
	if (lower.endsWith(".pdf")) return "application/pdf";
	return "application/octet-stream";
}

async function migrateLocalDataToServer({ dataDir, userDataDir, serverOrigin, dryRun = false, fetchImpl }) {
	if (typeof fetchImpl !== "function") {
		return { ok: false, error: "Network transport unavailable for server migration." };
	}
	const summary = inspectLocalDataDir(dataDir);
	if (!summary.hasData) {
		return { ok: false, error: "No local chats, knowledge graph, or flashcards were found to migrate." };
	}

	// Verify server session first so we fail cleanly if not signed in yet
	// Note: omit `redirect: "manual"` because Electron's net.fetch throws
	// "Redirect was cancelled" on manual redirects; check res.url instead.
	try {
		const sessRes = await fetchImpl(`${serverOrigin}/api/auth/session`, {
			method: "GET",
			headers: { accept: "application/json", origin: serverOrigin },
		});
		if (typeof sessRes.url === "string" && isCloudflareAccessUrl(sessRes.url)) {
			return { ok: false, error: "Cloudflare Access session expired. Reload the app to sign in again, then retry migration." };
		}
		if (sessRes.status !== 200) {
			return { ok: false, error: "Please sign in to your server first, then run migration again." };
		}
		const sess = await sessRes.json();
		if (sess?.authRequired && !sess?.authenticated) {
			return { ok: false, error: "Please sign in to your server account first, then run migration again." };
		}
	} catch (err) {
		return { ok: false, error: `Could not reach server: ${err?.message || String(err)}` };
	}

	const files = collectLocalFiles(dataDir);
	const attachmentFiles = [];
	const metadataFiles = [];

	for (const f of files) {
		if (f.rel.startsWith("attachments/")) {
			const parts = f.rel.split("/");
			if (parts.length === 3 && SHA256_RE.test(parts[1])) {
				attachmentFiles.push({ id: parts[1], filename: parts[2], abs: f.abs, rel: f.rel });
			}
		} else {
			metadataFiles.push(f);
		}
	}

	let localBackupPath;
	let uploadedAttachments = 0;
	let skippedAttachments = 0;

	if (!dryRun) {
		try {
			localBackupPath = createLocalSafetyCopy(dataDir, userDataDir);
		} catch (err) {
			return { ok: false, error: `Could not save local safety backup: ${err?.message || String(err)}` };
		}

		// Upload binary attachments one-by-one to /api/attachments (respects Cloudflare 100 MiB request cap)
		for (const att of attachmentFiles) {
			try {
				const bytes = fs.readFileSync(att.abs);
				const metaPath = path.join(path.resolve(dataDir), "attachments", `${att.id}.meta.json`);
				let mimeType = guessMimeType(att.filename);
				try {
					const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
					if (typeof meta?.mimeType === "string") mimeType = meta.mimeType;
				} catch { /* fallback to extension */ }
				const form = new FormData();
				form.append("file", new Blob([bytes], { type: mimeType }), att.filename);
				const res = await fetchImpl(`${serverOrigin}/api/attachments`, {
					method: "POST",
					headers: { origin: serverOrigin },
					body: form,
				});
				if (res.ok && !(typeof res.url === "string" && isCloudflareAccessUrl(res.url))) uploadedAttachments++;
				else skippedAttachments++;
			} catch {
				skippedAttachments++;
			}
		}
	}

	// Send lightweight metadata payload (chats, graph, jobs, prompts, themes, settings, flashcards)
	const payloadFiles = metadataFiles.map((f) => ({
		path: f.rel,
		contentBase64: fs.readFileSync(f.abs).toString("base64"),
	}));

	try {
		const res = await fetchImpl(`${serverOrigin}/api/backups/import`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json",
				origin: serverOrigin,
			},
			body: JSON.stringify({ files: payloadFiles, mode: "merge", dryRun: Boolean(dryRun) }),
		});
		if (typeof res.url === "string" && isCloudflareAccessUrl(res.url)) {
			return {
				ok: false,
				localBackupPath,
				error: "Cloudflare Access session expired during migration. Reload to sign in again, then retry.",
			};
		}
		const body = await res.json().catch(() => null);
		if (!res.ok) {
			return {
				ok: false,
				localBackupPath,
				error: body?.error || `Server import failed (HTTP ${res.status}).`,
			};
		}
		return {
			ok: true,
			dryRun: Boolean(dryRun),
			preview: body,
			localBackupPath,
			uploadedAttachments,
			skippedAttachments,
		};
	} catch (err) {
		return {
			ok: false,
			localBackupPath,
			error: `Migration request failed: ${err?.message || String(err)}`,
		};
	}
}

module.exports = {
	inspectLocalDataDir,
	createLocalSafetyCopy,
	migrateLocalDataToServer,
};
