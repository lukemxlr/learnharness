import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateMessageTokens, serializeForSummary } from "../src/core/compaction.ts";
import { newUserMessage } from "../src/core/native-messages.ts";
import type { AttachmentRef } from "../src/core/contracts/attachments.ts";

test("serializeForSummary and estimateMessageTokens handle multimodal user messages and attachments without matchAll crashes", () => {
	const imgAtt: AttachmentRef = {
		id: "a".repeat(64),
		filename: "graph.png",
		mimeType: "image/png",
		sizeBytes: 1234,
		kind: "image",
		url: `/api/attachments/${"a".repeat(64)}`,
	};
	const pdfAtt: AttachmentRef = {
		id: "b".repeat(64),
		filename: "lecture.pdf",
		mimeType: "application/pdf",
		sizeBytes: 4567,
		kind: "pdf",
		url: `/api/attachments/${"b".repeat(64)}`,
	};

	const arrayContentUser = {
		id: "u-multi",
		role: "user" as const,
		timestamp: 1,
		content: [
			{ type: "text" as const, text: "Check this note and the image" },
			{ type: "image" as const, mimeType: "image/png", data: "AAAA" },
		],
		attachments: [imgAtt, pdfAtt],
	};

	const attachmentOnlyUser = newUserMessage("", undefined, [imgAtt]);

	const summary = serializeForSummary([arrayContentUser, attachmentOnlyUser]);
	assert.match(summary, /\[LEARNER\] Check this note and the image/);
	assert.match(summary, /\[image\]/);
	assert.match(summary, /\[Image: graph\.png\]/);
	assert.match(summary, /\[PDF: lecture\.pdf\]/);

	const tokens = estimateMessageTokens(attachmentOnlyUser);
	assert.ok(tokens > 0);
});
