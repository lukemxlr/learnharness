#!/usr/bin/env node
/**
 * Safe Profile Migration CLI (Node 26 native ESM + TS type-stripping).
 *
 * Usage:
 *   node scripts/migrate-profile.mjs export --source <dir> --out <bundleDir> [--source-files-root <dir>] [--source-os <os>] [--json]
 *   node scripts/migrate-profile.mjs import --bundle <bundleDir> [--target <dir>] (--dry-run | --apply) [--target-platform <os>] [--json]
 */

import path from "node:path";
import { exportProfile, importProfile } from "../src/server/migration.ts";

function usage(exitCode = 1) {
	const out = exitCode === 0 ? console.log : console.error;
	out(
		"Usage:\n" +
		"  node scripts/migrate-profile.mjs export --source <dir> --out <bundleDir> [--source-files-root <dir>] [--source-os <os>] [--json]\n" +
		"  node scripts/migrate-profile.mjs import --bundle <bundleDir> [--target <dir>] (--dry-run | --apply) [--target-platform <os>] [--json]",
	);
	process.exit(exitCode);
}

function takeFlagValue(argv, index, flag) {
	if (index + 1 >= argv.length) {
		throw new Error(`Missing value for ${flag}`);
	}
	const val = argv[index + 1];
	if (val === undefined || val.startsWith("--")) {
		throw new Error(`Missing value for ${flag}`);
	}
	return val;
}

function parseArgs(argv) {
	if (argv.includes("--help") || argv.includes("-h")) {
		usage(0);
	}
	const [subcommand, ...rest] = argv;
	if (!subcommand || (subcommand !== "export" && subcommand !== "import")) {
		throw new Error(subcommand ? `Unknown subcommand: ${subcommand}` : "Missing subcommand (export | import)");
	}

	const flags = {
		source: undefined,
		out: undefined,
		sourceFilesRoot: undefined,
		sourceOs: undefined,
		bundle: undefined,
		target: undefined,
		targetPlatform: undefined,
		dryRun: false,
		apply: false,
		json: false,
	};

	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i];
		if (arg === "--source") {
			flags.source = takeFlagValue(rest, i, arg);
			i++;
		} else if (arg === "--out") {
			flags.out = takeFlagValue(rest, i, arg);
			i++;
		} else if (arg === "--source-files-root") {
			flags.sourceFilesRoot = takeFlagValue(rest, i, arg);
			i++;
		} else if (arg === "--source-os") {
			flags.sourceOs = takeFlagValue(rest, i, arg);
			i++;
		} else if (arg === "--bundle") {
			flags.bundle = takeFlagValue(rest, i, arg);
			i++;
		} else if (arg === "--target") {
			flags.target = takeFlagValue(rest, i, arg);
			i++;
		} else if (arg === "--target-platform") {
			flags.targetPlatform = takeFlagValue(rest, i, arg);
			i++;
		} else if (arg === "--dry-run") {
			flags.dryRun = true;
		} else if (arg === "--apply") {
			flags.apply = true;
		} else if (arg === "--json") {
			flags.json = true;
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}

	if (subcommand === "export") {
		if (!flags.source) throw new Error("--source is required for export");
		if (!flags.out) throw new Error("--out is required for export");
		if (flags.bundle || flags.target || flags.dryRun || flags.apply || flags.targetPlatform) {
			throw new Error("Import flags cannot be used with export");
		}
	} else {
		if (!flags.bundle) throw new Error("--bundle is required for import");
		if (flags.dryRun && flags.apply) throw new Error("Specify either --dry-run or --apply, not both");
		if (!flags.dryRun && !flags.apply) throw new Error("Either --dry-run or --apply is required for import");
		if (flags.source || flags.out || flags.sourceFilesRoot || flags.sourceOs) {
			throw new Error("Export flags cannot be used with import");
		}
	}

	return { subcommand, flags };
}

function formatDiagnostics(diagnostics) {
	if (!diagnostics || diagnostics.length === 0) return "  (none)";
	return diagnostics
		.map((d) => `  [${d.severity.toUpperCase()}][${d.code}] ${d.location}: ${d.message}`)
		.join("\n");
}

function printExportSummary(report) {
	const c = report.manifest.counts;
	console.log("=== LearnHarness Profile Export Summary ===");
	console.log(`Source (read-only): ${report.sourceDir}`);
	console.log(`Bundle output:      ${report.bundleDir}`);
	console.log(`Format version:     v${report.manifest.formatVersion} (sourceOs=${report.manifest.sourceOs})`);
	console.log(
		`Bundled items:      chats=${c.chats}, attachments=${c.attachments}, ` +
		`nodes=${c.graphNodes}, chains=${c.graphChains}, sessions=${c.graphSessions}, ` +
		`coverage=${c.graphCoverage}, sources=${c.graphSources}, jobs=${c.jobs}, prompts=${c.prompts}, themes=${c.themes}`,
	);
	console.log(`Skipped orphans:    ${report.skippedOrphans.totalCount} (attachments=${report.skippedOrphans.attachmentIds.length}, sourceFiles=${report.skippedOrphans.sourceFiles.length})`);
	console.log(`Excluded secrets:   ${report.excludedSecrets.length > 0 ? report.excludedSecrets.join(", ") : "(none)"}`);
	console.log(`Legacy ledgers:     ${report.legacyLedgers.length > 0 ? report.legacyLedgers.join(", ") : "(none)"}`);
	console.log("Diagnostics:");
	console.log(formatDiagnostics(report.diagnostics));
}

function printImportSummary(report) {
	const modeLabel = report.dryRun ? "DRY-RUN PREVIEW (0 bytes written)" : "APPLY";
	console.log(`=== LearnHarness Profile Import (${modeLabel}) ===`);
	console.log(`Bundle:             ${report.bundleDir}`);
	console.log(`Target:             ${report.targetDir} (platform=${report.targetPlatform})`);
	console.log(`Integrity valid:    ${report.integrity.valid}`);
	if (!report.integrity.valid) {
		console.log("Integrity errors:");
		for (const err of report.integrity.errors) {
			console.log(`  - ${err}`);
		}
	}
	console.log(`Bytes written:      ${report.bytesWrittenToTarget}`);
	console.log(
		`Chats:              create=${report.chats.create.length}, update=${report.chats.update.length}, ` +
		`skipServerNewer=${report.chats.skipServerNewer.length}, skipUnchanged=${report.chats.skipUnchanged.length}, skipNewerSchema=${report.chats.skipNewerSchema.length}`,
	);
	console.log(
		`Attachments:        ingest=${report.attachments.ingest.length}, alreadyPresent=${report.attachments.alreadyPresent.length}`,
	);
	console.log(
		`Graph:              nodes(+${report.graph.nodesAdded}/=${report.graph.nodesSkipped}), ` +
		`chains(+${report.graph.chainsAdded}/=${report.graph.chainsSkipped}), ` +
		`sessions(+${report.graph.sessionsAdded}/=${report.graph.sessionsSkipped}), ` +
		`coverage(+${report.graph.coverageAdded}/~${report.graph.coverageUpdated}/=${report.graph.coverageSkipped}), ` +
		`sources(+${report.graph.sourcesAdded}/~${report.graph.sourcesUpdated}/=${report.graph.sourcesPreserved})`,
	);
	console.log(
		`Settings:           action=${report.settings.action}, restricted=${report.settings.preservedRestricted}, ` +
		`strippedWindowsFolders=${report.settings.strippedWindowsFolders.length > 0 ? JSON.stringify(report.settings.strippedWindowsFolders) : "[]"}`,
	);
	console.log(
		`Other:              jobs(create=${report.jobs.create.length}, update=${report.jobs.update.length}, skip=${report.jobs.skipUnchanged.length + report.jobs.skipServerNewer.length}), ` +
		`prompts(create=${report.prompts.create.length}, skip=${report.prompts.skipExisting.length}), ` +
		`themes(create=${report.themes.create.length}, skip=${report.themes.skipExisting.length})`,
	);
	console.log("Diagnostics:");
	console.log(formatDiagnostics(report.diagnostics));
}

function main() {
	let parsed;
	try {
		parsed = parseArgs(process.argv.slice(2));
	} catch (err) {
		console.error(`[migrate-profile] ${err instanceof Error ? err.message : String(err)}`);
		usage(1);
	}

	const { subcommand, flags } = parsed;

	if (subcommand === "export") {
		const report = exportProfile({
			sourceDir: path.resolve(flags.source),
			bundleDir: path.resolve(flags.out),
			...(flags.sourceFilesRoot ? { sourceFilesRoot: path.resolve(flags.sourceFilesRoot) } : {}),
			...(flags.sourceOs ? { sourceOs: flags.sourceOs } : {}),
		});
		if (flags.json) {
			console.log(JSON.stringify(report, null, 2));
		} else {
			printExportSummary(report);
		}
		return;
	}

	const defaultTarget = process.env.LH_DATA_DIR
		? path.resolve(process.env.LH_DATA_DIR)
		: path.resolve(process.cwd(), "data");
	const targetDir = flags.target ? path.resolve(flags.target) : defaultTarget;

	const report = importProfile({
		bundleDir: path.resolve(flags.bundle),
		targetDir,
		dryRun: flags.dryRun,
		...(flags.targetPlatform ? { targetPlatform: flags.targetPlatform } : {}),
	});

	if (flags.json) {
		console.log(JSON.stringify(report, null, 2));
	} else {
		printImportSummary(report);
	}

	if (!report.integrity.valid) {
		process.exitCode = 1;
	}
}

try {
	main();
} catch (err) {
	console.error(`[migrate-profile] ${err instanceof Error ? err.message : String(err)}`);
	process.exit(1);
}
