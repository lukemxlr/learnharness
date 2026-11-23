import { parseAttachmentRef, type AttachmentRef } from "@/src/core";

/**
 * Same-tab handover of a new session's full opening text and staged attachments.
 * Never put the message in the navigation URL: long query payloads can be
 * rejected before the chat page loads. Storage is required for automatic
 * delivery, not an optional best-effort side effect of navigating away from
 * the source draft.
 */
export const OPENING_PROMPT_FAILURE = "Couldn’t open the session. Your message is still here. Try sending again.";

export interface OpeningPrompt {
	text: string;
	/** Written BEFORE sending. A later mount restores a draft, never reposts. */
	attempted: boolean;
	attachments?: AttachmentRef[];
}

const keyFor = (id: string) => `lh.openingPrompt.${id}`;

function normalizeAttachments(raw: unknown): AttachmentRef[] {
	if (!Array.isArray(raw)) return [];
	const valid: AttachmentRef[] = [];
	for (const item of raw) {
		try {
			valid.push(parseAttachmentRef(item));
		} catch {
			/* ignore invalid attachment entries */
		}
	}
	return valid;
}

export function stashOpeningPrompt(
	id: string,
	text: string,
	attempted = false,
	attachments?: readonly AttachmentRef[],
): boolean {
	try {
		const normalized = normalizeAttachments(attachments);
		const payload: OpeningPrompt = normalized.length > 0
			? { text, attempted, attachments: normalized }
			: { text, attempted };
		const value = JSON.stringify(payload);
		// Catch both the storage getter and its methods (quota/security errors).
		const storage = globalThis.sessionStorage;
		storage.setItem(keyFor(id), value);
		return storage.getItem(keyFor(id)) === value;
	} catch {
		return false;
	}
}

export function readOpeningPromptEntry(id: string): OpeningPrompt | undefined {
	try {
		const value = globalThis.sessionStorage.getItem(keyFor(id));
		if (!value) return undefined;
		try {
			const entry: unknown = JSON.parse(value);
			if (
				entry &&
				typeof entry === "object" &&
				"text" in entry &&
				typeof entry.text === "string" &&
				"attempted" in entry &&
				typeof entry.attempted === "boolean"
			) {
				const attachments = "attachments" in entry ? normalizeAttachments(entry.attachments) : [];
				if (entry.text.length > 0 || attachments.length > 0) {
					return attachments.length > 0
						? { text: entry.text, attempted: entry.attempted, attachments }
						: { text: entry.text, attempted: entry.attempted };
				}
			}
		} catch { /* Old raw-text stashes have no proof that sending never began. */ }
		return { text: value, attempted: true };
	} catch {
		return undefined;
	}
}

export function readOpeningPrompt(id: string): string | undefined {
	return readOpeningPromptEntry(id)?.text;
}

export function clearOpeningPrompt(id: string): boolean {
	try {
		globalThis.sessionStorage.removeItem(keyFor(id));
		return true;
	} catch {
		// Canonical conversation/acknowledgment remains the truth. A later
		// mount with real conversation can try cleanup again; never crash it.
		return false;
	}
}
