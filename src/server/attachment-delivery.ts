import fs from "node:fs";
import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { PATHS } from "../../config.ts";
import { processImage } from "../agent/image-processing/index.ts";
import type { PiEngine } from "../agent/models.ts";
import { realHeadless } from "../agent/subagents/headless.ts";
import { joinPages } from "../agent/subagents/pdf-markdown.ts";
import { convertPdf } from "../agent/subagents/pdf-ops.ts";
import type { AttachmentRef } from "../core/contracts/attachments.ts";
import type { TurnInput, UserSteerInput } from "../core/input-events.ts";
import { ChatInputError } from "../core/input-events.ts";
import type { LhMarkerMessage, LhMessage } from "../core/native-messages.ts";
import type { QuestionAnswerData } from "../core/question-core.ts";
import { writeFileAtomicSync } from "../store/atomic-write.ts";
import { readAttachmentBytes, resolveAttachmentFile } from "./attachments.ts";
import { submissionImagePolicyKey } from "./submission-images.ts";

export type ResolvedAttachmentBlocks = (TextContent | ImageContent)[];
export type ResolvedAttachmentMap = Map<string, ResolvedAttachmentBlocks>;

export const MAX_ATTACHMENT_PDF_PAGES = 200;
export const MAX_ATTACHMENT_PDF_RENDER_PAGES = 10;

type ImageEngine = Pick<PiEngine, "model">;

interface CachedPdfExtraction {
	version: 1;
	id: string;
	kind: "text" | "image-only" | "empty";
	pageCount: number;
	markdown?: string;
	renderedPages?: Array<{ page: number; mimeType: "image/png"; data: string }>;
}

export interface AttachmentDeliveryDeps {
	dataDir?: string;
	convertPdf?: typeof convertPdf;
	joinPages?: typeof joinPages;
	renderPdfPages?: typeof realHeadless.renderPdfPages;
	processImage?: typeof processImage;
}

const g = globalThis as typeof globalThis & {
	__lhLiveTurnAttachments?: Map<string, { policy: string; map: ResolvedAttachmentMap }>;
};

function liveTurnRegistry(): Map<string, { policy: string; map: ResolvedAttachmentMap }> {
	return (g.__lhLiveTurnAttachments ??= new Map());
}

export function setLiveTurnAttachments(chatId: string, engine: ImageEngine, map: ResolvedAttachmentMap): void {
	liveTurnRegistry().set(chatId, { policy: submissionImagePolicyKey(engine), map });
}

export function clearLiveTurnAttachments(chatId: string, map?: ResolvedAttachmentMap): void {
	const registry = liveTurnRegistry();
	const current = registry.get(chatId);
	if (!current) return;
	if (!map || current.map === map) registry.delete(chatId);
}

function pdfCachePath(dataDir: string, id: string): string {
	return path.join(/* turbopackIgnore: true */ path.resolve(/* turbopackIgnore: true */ dataDir), "attachments", id, `${id}.extracted.json`);
}

function readPdfCache(dataDir: string, id: string): CachedPdfExtraction | null {
	try {
		const raw = fs.readFileSync(pdfCachePath(dataDir, id), "utf8");
		const parsed = JSON.parse(raw) as Partial<CachedPdfExtraction> | null;
		if (!parsed || parsed.version !== 1 || parsed.id !== id) return null;
		if (parsed.kind !== "text" && parsed.kind !== "image-only" && parsed.kind !== "empty") return null;
		if (typeof parsed.pageCount !== "number") return null;
		return parsed as CachedPdfExtraction;
	} catch {
		return null;
	}
}

function writePdfCache(dataDir: string, cache: CachedPdfExtraction): void {
	try {
		const file = pdfCachePath(dataDir, cache.id);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		writeFileAtomicSync(file, `${JSON.stringify(cache)}\n`, { allowInPlaceFallback: true });
	} catch {
		// Cache writes are best-effort; extraction results are still returned.
	}
}

async function resolveImageAttachment(
	ref: AttachmentRef,
	engine: ImageEngine,
	strict: boolean,
	deps: AttachmentDeliveryDeps,
): Promise<ResolvedAttachmentBlocks> {
	const dataDir = deps.dataDir ?? PATHS.data;
	const processImg = deps.processImage ?? processImage;
	if (!engine.model.input.includes("image")) {
		if (strict) {
			throw new ChatInputError("The selected model does not support images. Your input has been kept.");
		}
		return [{ type: "text", text: `[Attached image omitted (${ref.filename}): selected model does not support image input.]` }];
	}
	const loaded = readAttachmentBytes(ref.id, dataDir);
	if (!loaded) {
		if (strict) {
			throw new ChatInputError(`Attachment "${ref.filename}" could not be found. Your input has been kept.`);
		}
		return [{ type: "text", text: `[Attached image unavailable: ${ref.filename}]` }];
	}
	if (loaded.meta.mimeType !== ref.mimeType || loaded.meta.sizeBytes !== ref.sizeBytes) {
		if (strict) {
			throw new ChatInputError(`Attachment "${ref.filename}" metadata does not match stored file. Your input has been kept.`);
		}
		return [{ type: "text", text: `[Attached image unavailable: ${ref.filename}]` }];
	}
	const resizeOptions = { ...engine.model.inputLimits?.images?.resize };
	try {
		const result = await processImg(loaded.bytes, loaded.meta.mimeType, { resizeOptions });
		if (!result.ok) {
			if (strict) {
				throw new ChatInputError(`Could not prepare the attached image "${ref.filename}". Your input has been kept.`);
			}
			return [{ type: "text", text: `[Attached image could not be processed: ${ref.filename}]` }];
		}
		return [{ type: "image", data: result.data, mimeType: result.mimeType }];
	} catch (error) {
		if (error instanceof ChatInputError) throw error;
		if (strict) {
			throw new ChatInputError(`Could not prepare the attached image "${ref.filename}". Your input has been kept.`);
		}
		return [{ type: "text", text: `[Attached image could not be processed: ${ref.filename}]` }];
	}
}

async function resolvePdfAttachment(
	ref: AttachmentRef,
	engine: ImageEngine,
	strict: boolean,
	deps: AttachmentDeliveryDeps,
): Promise<ResolvedAttachmentBlocks> {
	const dataDir = deps.dataDir ?? PATHS.data;
	const pdfConvert = deps.convertPdf ?? convertPdf;
	const pdfJoin = deps.joinPages ?? joinPages;
	const renderPages = deps.renderPdfPages ?? realHeadless.renderPdfPages;
	const processImg = deps.processImage ?? processImage;
	const canSeeImages = engine.model.input.includes("image");

	const resolved = resolveAttachmentFile(ref.id, dataDir);
	const loaded = resolved ? readAttachmentBytes(ref.id, dataDir) : null;
	if (!resolved || !loaded || loaded.meta.mimeType !== "application/pdf") {
		if (strict) {
			throw new ChatInputError(`PDF attachment "${ref.filename}" could not be found. Your input has been kept.`);
		}
		return [{ type: "text", text: `[Attached PDF unavailable: ${ref.filename}]` }];
	}

	let cache = readPdfCache(dataDir, ref.id);
	if (!cache) {
		let conversion: Awaited<ReturnType<typeof convertPdf>>;
		try {
			conversion = await pdfConvert(new Uint8Array(loaded.bytes), MAX_ATTACHMENT_PDF_PAGES);
		} catch (error) {
			const detail = error instanceof Error && error.message ? ` (${error.message})` : "";
			if (strict) {
				throw new ChatInputError(`Could not read PDF "${ref.filename}"${detail}. Your input has been kept.`);
			}
			return [{ type: "text", text: `[Attached PDF unreadable: ${ref.filename}]` }];
		}
		if (conversion.kind === "unreadable") {
			if (strict) {
				throw new ChatInputError(`Could not read PDF "${ref.filename}". The file may be corrupted or encrypted. Your input has been kept.`);
			}
			return [{ type: "text", text: `[Attached PDF unreadable: ${ref.filename}]` }];
		}
		if (conversion.kind === "too-long") {
			if (strict) {
				throw new ChatInputError(`PDF "${ref.filename}" has ${conversion.pageCount} pages, which exceeds the ${MAX_ATTACHMENT_PDF_PAGES}-page limit. Your input has been kept.`);
			}
			return [{ type: "text", text: `[Attached PDF omitted (${ref.filename}): ${conversion.pageCount} pages exceeds limit]` }];
		}
		const markdown = pdfJoin(conversion.pages).trim();
		if (markdown.length > 0) {
			cache = {
				version: 1,
				id: ref.id,
				kind: "text",
				pageCount: conversion.pages.length,
				markdown,
			};
			writePdfCache(dataDir, cache);
		} else if (conversion.pages.some((p) => p.kind === "image-only")) {
			cache = {
				version: 1,
				id: ref.id,
				kind: "image-only",
				pageCount: conversion.pages.length,
			};
			writePdfCache(dataDir, cache);
		} else {
			cache = {
				version: 1,
				id: ref.id,
				kind: "empty",
				pageCount: conversion.pages.length,
			};
			writePdfCache(dataDir, cache);
		}
	}

	if (cache.kind === "text") {
		return [{ type: "text", text: `[Attached PDF: ${ref.filename}]\n\n${cache.markdown ?? ""}` }];
	}
	if (cache.kind === "empty") {
		return [{ type: "text", text: `[Attached PDF: ${ref.filename} — no text or image content was found.]` }];
	}

	// Scanned / image-only PDF
	if (!canSeeImages) {
		return [{
			type: "text",
			text: `[Attached PDF: ${ref.filename} (${cache.pageCount} page${cache.pageCount === 1 ? "" : "s"}) — this PDF contains only scanned images and no extractable text, and the selected model (${engine.model.id}) does not support image input.]`,
		}];
	}

	let renderedPages = cache.renderedPages;
	if (!renderedPages || renderedPages.length === 0) {
		const count = Math.min(Math.max(cache.pageCount, 1), MAX_ATTACHMENT_PDF_RENDER_PAGES);
		const pageNums = Array.from({ length: count }, (_, i) => i + 1);
		try {
			const rendered = await renderPages(resolved.filePath, pageNums, { dpi: 150 });
			renderedPages = rendered.map((page) => ({
				page: page.page,
				mimeType: "image/png" as const,
				data: Buffer.from(page.png).toString("base64"),
			}));
			cache = { ...cache, renderedPages };
			writePdfCache(dataDir, cache);
		} catch (error) {
			const detail = error instanceof Error && error.message ? ` (${error.message})` : "";
			if (strict) {
				throw new ChatInputError(`Could not render scanned PDF "${ref.filename}"${detail}. Your input has been kept.`);
			}
			return [{ type: "text", text: `[Attached scanned PDF could not be rendered: ${ref.filename}]` }];
		}
	}

	const resizeOptions = { ...engine.model.inputLimits?.images?.resize };
	const imageBlocks: ImageContent[] = [];
	for (const page of renderedPages) {
		const processed = await processImg(Buffer.from(page.data, "base64"), page.mimeType, { resizeOptions });
		if (processed.ok) {
			imageBlocks.push({ type: "image", data: processed.data, mimeType: processed.mimeType });
		}
	}
	if (imageBlocks.length === 0) {
		if (strict) {
			throw new ChatInputError(`Could not prepare rendered pages for PDF "${ref.filename}". Your input has been kept.`);
		}
		return [{ type: "text", text: `[Attached scanned PDF could not be processed: ${ref.filename}]` }];
	}
	return [
		{
			type: "text",
			text: `[Attached PDF (scanned/image-only): ${ref.filename} (${cache.pageCount} page${cache.pageCount === 1 ? "" : "s"}, showing ${imageBlocks.length})]`,
		},
		...imageBlocks,
	];
}

export async function resolveSingleAttachment(
	ref: AttachmentRef,
	engine: ImageEngine,
	strict: boolean,
	deps: AttachmentDeliveryDeps = {},
): Promise<ResolvedAttachmentBlocks> {
	if (ref.kind === "image") {
		return resolveImageAttachment(ref, engine, strict, deps);
	}
	if (ref.kind === "pdf") {
		return resolvePdfAttachment(ref, engine, strict, deps);
	}
	if (strict) {
		throw new ChatInputError(`Unsupported attachment kind: ${String(ref.kind)}`);
	}
	return [];
}

function attachmentsOfMessage(message: LhMessage): AttachmentRef[] {
	const refs: AttachmentRef[] = [];
	if (message.role === "user" && Array.isArray(message.attachments)) {
		refs.push(...message.attachments);
	} else if (message.role === "toolResult") {
		const details = message.details as Partial<QuestionAnswerData> | null | undefined;
		if (details && Array.isArray(details.attachments)) {
			refs.push(...details.attachments);
		}
	} else if (message.role === "custom" && message.customType === "practice-thinking") {
		const details = message.details as { attachments?: AttachmentRef[] } | null | undefined;
		if (details && Array.isArray(details.attachments)) {
			refs.push(...details.attachments);
		}
	}
	return refs;
}

function attachmentsOfInput(input: TurnInput): AttachmentRef[] {
	switch (input.type) {
		case "text":
		case "thinking":
			return input.attachments ?? [];
		case "answer":
			return input.answer.attachments ?? [];
		case "steers":
			return input.steers.flatMap(attachmentsOfMessage);
		default:
			return [];
	}
}

/**
 * Resolve every AttachmentRef needed for a turn (incoming input strictly,
 * historical messages best-effort) into an immutable-keyed map.
 */
export async function resolveTurnAttachments(
	messages: readonly LhMessage[],
	input: TurnInput | null,
	engine: ImageEngine,
	deps: AttachmentDeliveryDeps = {},
): Promise<ResolvedAttachmentMap> {
	const map: ResolvedAttachmentMap = new Map();
	const strictRefs = input ? attachmentsOfInput(input) : [];
	const strictIds = new Set(strictRefs.map((ref) => ref.id));

	// Resolve strict current-turn inputs first so invalid/corrupt/unsupported
	// attachments fail loudly before persistence or turn start.
	for (const ref of strictRefs) {
		if (map.has(ref.id)) continue;
		const blocks = await resolveSingleAttachment(ref, engine, true, deps);
		map.set(ref.id, blocks);
	}

	// Hydrate historical attachments best-effort for multi-turn continuity.
	for (const message of messages) {
		for (const ref of attachmentsOfMessage(message)) {
			if (map.has(ref.id)) continue;
			const blocks = await resolveSingleAttachment(ref, engine, strictIds.has(ref.id), deps);
			map.set(ref.id, blocks);
		}
	}
	return map;
}

export async function prepareSteerAttachments(
	chatId: string,
	attachments: readonly AttachmentRef[] | undefined,
	engine: ImageEngine,
	deps: AttachmentDeliveryDeps = {},
): Promise<AttachmentRef[] | undefined> {
	if (!attachments?.length) return undefined;
	const resolved = new Map<string, ResolvedAttachmentBlocks>();
	for (const ref of attachments) {
		if (!resolved.has(ref.id)) {
			resolved.set(ref.id, await resolveSingleAttachment(ref, engine, true, deps));
		}
	}
	const entry = liveTurnRegistry().get(chatId);
	const policy = submissionImagePolicyKey(engine);
	if (entry && entry.policy === policy) {
		for (const [id, blocks] of resolved) entry.map.set(id, blocks);
	} else {
		liveTurnRegistry().set(chatId, { policy, map: resolved });
	}
	return attachments.map((a) => ({ ...a }));
}

export function hydrateMessagesSync(
	messages: readonly AgentMessage[],
	map: ResolvedAttachmentMap,
): AgentMessage[] {
	const hasAny = messages.some((m) => attachmentsOfMessage(m as LhMessage).length > 0);
	if (!hasAny) return messages as AgentMessage[];

	return messages.map((raw) => {
		const m = raw as LhMessage;
		if (m.role === "user" && Array.isArray(m.attachments) && m.attachments.length > 0) {
			const user = m as LhMessage & UserMessage;
			const base: (TextContent | ImageContent)[] = typeof user.content === "string"
				? (user.content ? [{ type: "text", text: user.content }] : [])
				: [...user.content];
			for (const ref of m.attachments) {
				const blocks = map.get(ref.id);
				if (blocks) base.push(...blocks);
				else base.push({ type: "text", text: `[Attachment unavailable: ${ref.filename}]` });
			}
			return { ...user, content: base } as unknown as AgentMessage;
		}
		if (m.role === "toolResult") {
			const result = m as LhMessage & ToolResultMessage;
			const details = result.details as Partial<QuestionAnswerData> | null | undefined;
			if (details && Array.isArray(details.attachments) && details.attachments.length > 0) {
				const extra: (TextContent | ImageContent)[] = [];
				for (const ref of details.attachments) {
					const blocks = map.get(ref.id);
					if (blocks) extra.push(...blocks);
				}
				if (extra.length > 0) {
					return {
						...result,
						content: [...result.content, { type: "text", text: "Answer images:" }, ...extra],
					} as unknown as AgentMessage;
				}
			}
		}
		if (m.role === "custom" && m.customType === "practice-thinking") {
			const marker = m as LhMarkerMessage;
			const details = marker.details as { images?: ImageContent[]; attachments?: AttachmentRef[] } | null | undefined;
			if (details && Array.isArray(details.attachments) && details.attachments.length > 0) {
				const extraImages: ImageContent[] = [];
				const extraText: string[] = [];
				for (const ref of details.attachments) {
					const blocks = map.get(ref.id);
					if (!blocks) continue;
					for (const b of blocks) {
						if (b.type === "image") extraImages.push(b);
						else if (b.type === "text" && b.text) extraText.push(b.text);
					}
				}
				return {
					...marker,
					content: extraText.length ? `${marker.content}\n\n${extraText.join("\n\n")}` : marker.content,
					details: {
						...details,
						images: [...(details.images ?? []), ...extraImages],
					},
				} as unknown as AgentMessage;
			}
		}
		return raw;
	});
}
