"use client";

import type { ComponentProps } from "react";

/** The core and controlled plugin pickers share the very same trigger renderer. */
export function ModelPickerPill({ children, ...props }: ComponentProps<"button">) {
	return <button type="button" {...props}
		className="flex min-h-11 min-w-11 max-w-full items-center justify-center gap-1.5 rounded-full border bg-card/85 px-3 py-1.5 font-ui text-xs shadow-lg backdrop-blur transition-colors hover:border-border hover:bg-muted">
		<span className="max-w-[10rem] sm:max-w-[16rem] truncate text-card-foreground">{children}</span>
		<span aria-hidden className="shrink-0 text-xs text-muted-foreground">▾</span>
	</button>;
}
