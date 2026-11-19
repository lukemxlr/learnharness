"use client";

import type { ImageContent } from "@earendil-works/pi-ai";
import { FileTextIcon } from "lucide-react";
import type { AttachmentRef } from "@/src/core";
import { useSessionMermaid } from "./session-overlay";

// Use session prose metrics, not the compact labels surrounding thinking/images.
const previewSize = "calc(var(--lh-prose-size) * var(--lh-prose-leading) * 5)";

/** Explicit native image data and persisted attachment references. */
export function SubmittedImages({
	images,
	attachments,
}: {
	images?: readonly Readonly<ImageContent>[];
	attachments?: readonly AttachmentRef[];
}) {
	const viewer = useSessionMermaid();
	if (!images?.length && !attachments?.length) return null;
	const imageAttachments = attachments?.filter((att) => att.kind === "image") ?? [];
	const pdfAttachments = attachments?.filter((att) => att.kind === "pdf") ?? [];
	return <div className="w-full space-y-3" data-testid="submitted-images">
		{pdfAttachments.length > 0 && (
			<div className="mt-2 flex flex-wrap gap-2">
				{pdfAttachments.map((att, index) => (
					<a
						key={`${att.id}-${index}`}
						href={att.url}
						target="_blank"
						rel="noopener noreferrer"
						data-testid="submitted-pdf-attachment"
						className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background/70 px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent"
					>
						<FileTextIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
						<span>{att.filename}</span>
					</a>
				))}
			</div>
		)}
		{images?.map((image, index) => {
			const src = `data:${image.mimeType};base64,${image.data}`;
			const preview = (
				// Native accepted bytes have no remote optimization or re-encoding.
				// eslint-disable-next-line @next/next/no-img-element
				<img src={src} alt="Submitted image" draggable={false} className="block h-auto max-w-full opacity-100"
					style={{ maxHeight: previewSize, maxWidth: `min(100%, ${previewSize})` }} />
			);
			return <figure key={`inline-${index}`} className="mx-auto my-3 w-fit max-w-full">
				{viewer?.openImage ? <button type="button" className="block max-w-full cursor-zoom-in" aria-label="Open submitted image fullscreen"
					onClick={event => {
						const element = event.currentTarget.querySelector("img");
						if (element?.naturalWidth && element.naturalHeight) viewer.openImage?.({ src, width: element.naturalWidth, height: element.naturalHeight });
					}}>{preview}</button> : preview}
			</figure>;
		})}
		{imageAttachments.map((att, index) => {
			const src = att.url;
			const preview = (
				// eslint-disable-next-line @next/next/no-img-element
				<img src={src} alt={att.filename} draggable={false} className="block h-auto max-w-full opacity-100"
					style={{ maxHeight: previewSize, maxWidth: `min(100%, ${previewSize})` }} />
			);
			return <figure key={`att-${att.id}-${index}`} className="mx-auto my-3 w-fit max-w-full">
				{viewer?.openImage ? <button type="button" className="block max-w-full cursor-zoom-in" aria-label={`Open ${att.filename} fullscreen`}
					onClick={event => {
						const element = event.currentTarget.querySelector("img");
						if (element?.naturalWidth && element.naturalHeight) viewer.openImage?.({ src, width: element.naturalWidth, height: element.naturalHeight });
					}}>{preview}</button> : preview}
			</figure>;
		})}
	</div>;
}
