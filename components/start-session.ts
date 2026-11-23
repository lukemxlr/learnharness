import type { AttachmentRef } from "@/src/core";
import { clearOpeningPrompt, OPENING_PROMPT_FAILURE, stashOpeningPrompt } from "./opening-prompt";

interface SessionCreation {
	title: string;
	kind?: "practice";
	graphContext?: { propositions: readonly { id: string; name: string; statement: string }[] };
	/** Optional opening prompt text if it differs from the session title (e.g. attachment-only start). */
	openingText?: string;
	/** Optional attachments staged before session creation. */
	attachments?: readonly AttachmentRef[];
}

/** Per source-composer instance. Retain a successful creation if storage
 * fails, so an unchanged retry does not create another empty session.
 * Changed text/context/settings is a different start, not a stale title.
 */
export class SessionStarter {
	private created?: { identity: string; id: string };

	async start(body: SessionCreation, fetchLike: typeof fetch, settingsIdentity?: string): Promise<string> {
		const { attachments, openingText, ...createPayload } = body;
		const identity = JSON.stringify([body, settingsIdentity]);
		if (this.created?.identity !== identity) {
			if (this.created) clearOpeningPrompt(this.created.id);
			this.created = undefined;
			const res = await fetchLike("/api/chats", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(createPayload),
			});
			if (!res.ok) throw new Error(OPENING_PROMPT_FAILURE);
			const result = await res.json() as { id?: unknown };
			if (typeof result.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(result.id)) throw new Error(OPENING_PROMPT_FAILURE);
			this.created = { identity, id: result.id };
		}
		const stashText = openingText !== undefined ? openingText : body.title;
		if (!stashOpeningPrompt(this.created.id, stashText, false, attachments)) throw new Error(OPENING_PROMPT_FAILURE);
		return `/chat/${this.created.id}`;
	}
}
