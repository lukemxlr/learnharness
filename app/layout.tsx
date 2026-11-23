import type { Metadata, Viewport } from "next";
import { JetBrains_Mono, Source_Sans_3 } from "next/font/google";
import { connection } from "next/server";
import "katex/dist/katex.min.css";
import "./globals.css";
import { AppShell, SidebarProvider } from "@/components/sidebar";
import { ActivityProvider } from "@/components/activity-dock";
import { ServerEventsProvider } from "@/components/server-events";
import { AppearanceProvider } from "@/components/settings/appearance";
import UpdateBanner from "@/components/update-banner";
import { PluginsProvider } from "@/components/plugins";
import { resolveTheme, themeVars } from "@/src/core";
import { readThemeBoot } from "@/src/server";
import { getServerAuthState } from "./_lib/auth.ts";

// Chrome = JetBrains Mono, teaching prose = Source Sans 3, titles = CMU
// Serif (the bundled lh-cmu @font-face in globals.css — no CDN).
const ui = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains" });
const prose = Source_Sans_3({ subsets: ["latin"], variable: "--font-sans3" });

export const metadata: Metadata = {
	title: "LearnHarness",
	description: "A teacher agent with a memory — sessions, quizzes, and a knowledge graph of what you know.",
	applicationName: "LearnHarness",
	appleWebApp: {
		capable: true,
		title: "LearnHarness",
		statusBarStyle: "black-translucent",
	},
};

export const viewport: Viewport = {
	width: "device-width",
	initialScale: 1,
	// Prevent mobile WebKit / iPadOS Safari shrink-to-fit scale drift across rapid
	// orientation and Split-View resizes while keeping pinch-zoom unrestricted.
	minimumScale: 1,
	viewportFit: "cover",
	themeColor: [
		{ media: "(prefers-color-scheme: dark)", color: "#141414" },
		{ media: "(prefers-color-scheme: light)", color: "#fafafa" },
	],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
	// The theme is server-rendered — its class AND its color variables —
	// so no first frame ever shows the wrong theme. connection(): the
	// record and the theme files are per-machine disk state — without it a
	// prerendered route (settings) would bake the BUILD machine's record.
	await connection();
	const authState = await getServerAuthState();
	const shellActive = !authState.authRequired || authState.authenticated;
	const defaultTheme = resolveTheme(undefined);
	const { appearance, theme, vars } = shellActive
		? readThemeBoot()
		: {
				appearance: undefined,
				theme: defaultTheme,
				vars: themeVars(defaultTheme.colors, defaultTheme.mode),
			};

	return (
		<html
			lang="en"
			className={`${theme.mode} ${ui.variable} ${prose.variable}`}
			style={vars as React.CSSProperties}
			suppressHydrationWarning
		>
			<body className="fixed inset-0 h-dvh w-full overflow-hidden overscroll-none antialiased">
				{shellActive ? (
					<>
						{/* The notification channel rides OUTSIDE everything: sidebar, dock,
							 and pages all subscribe as the polls retire (push S3, 2026-10-02). */}
						<ServerEventsProvider>
							<PluginsProvider>
								<AppearanceProvider initialAppearance={appearance} initialTheme={theme}>
									<SidebarProvider>
										<ActivityProvider>
											<AppShell>{children}</AppShell>
										</ActivityProvider>
									</SidebarProvider>
								</AppearanceProvider>
							</PluginsProvider>
						</ServerEventsProvider>
						{/* Auto-update banner (Wave C): fixed card, Electron-only pushes. */}
						<UpdateBanner />
					</>
				) : (
					children
				)}
			</body>
		</html>
	);
}
