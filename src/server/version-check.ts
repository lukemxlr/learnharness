import packageJson from "../../package.json";

export interface ServerUpdateCheckResult {
	currentVersion: string;
	latestVersion: string | null;
	updateAvailable: boolean;
	releaseUrl: string | null;
	checkedAt: string;
}

const CACHE_TTL_MS = 15 * 60 * 1000;
let cachedResult: { expiresAt: number; value: ServerUpdateCheckResult } | null = null;

/** Parse major.minor.patch from strings like "0.7.3" or "v0.7.3". Pure. */
export function parseSemverTriplet(raw: string | null | undefined): [number, number, number] | null {
	if (typeof raw !== "string") return null;
	const match = raw.trim().replace(/^v/i, "").match(/^(\d+)\.(\d+)\.(\d+)/);
	if (!match) return null;
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** True strictly when candidate is a newer major.minor.patch than current. Pure. */
export function isNewerSemver(candidate: string | null | undefined, current: string | null | undefined): boolean {
	const a = parseSemverTriplet(candidate);
	const b = parseSemverTriplet(current);
	if (!a || !b) return false;
	for (let i = 0; i < 3; i++) {
		if (a[i]! !== b[i]!) return a[i]! > b[i]!;
	}
	return false;
}

/** Extract `owner/repo` from a GitHub homepage URL (e.g. https://github.com/owner/repo). */
export function githubRepoSlugFromHomepage(homepage: string | null | undefined): string | null {
	if (typeof homepage !== "string") return null;
	try {
		const url = new URL(homepage);
		if (url.hostname.toLowerCase() !== "github.com") return null;
		const parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
		if (parts.length < 2 || !parts[0] || !parts[1]) return null;
		return `${parts[0]}/${parts[1].replace(/\.git$/i, "")}`;
	} catch {
		return null;
	}
}

export function resetServerUpdateCacheForTest(): void {
	cachedResult = null;
}

export async function checkLatestServerRelease(options?: {
	currentVersion?: string;
	homepage?: string;
	fetchImpl?: typeof fetch;
	bypassCache?: boolean;
}): Promise<ServerUpdateCheckResult> {
	const currentVersion = options?.currentVersion ?? packageJson.version ?? "";
	const homepage = options?.homepage ?? packageJson.homepage ?? "";
	const now = Date.now();
	if (!options?.bypassCache && !options?.fetchImpl && cachedResult && cachedResult.expiresAt > now) {
		return cachedResult.value;
	}
	const fallback: ServerUpdateCheckResult = {
		currentVersion,
		latestVersion: null,
		updateAvailable: false,
		releaseUrl: null,
		checkedAt: new Date(now).toISOString(),
	};
	const slug = githubRepoSlugFromHomepage(homepage);
	if (!slug) return fallback;

	const fetchFn = options?.fetchImpl ?? globalThis.fetch;
	if (typeof fetchFn !== "function") return fallback;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 5000);
	timer.unref?.();
	try {
		const res = await fetchFn(`https://api.github.com/repos/${slug}/releases/latest`, {
			headers: {
				accept: "application/vnd.github+json",
				"user-agent": `LearnHarness/${currentVersion}`,
			},
			signal: controller.signal,
		});
		if (!res.ok) return fallback;
		const data = (await res.json()) as { tag_name?: unknown; html_url?: unknown; draft?: unknown; prerelease?: unknown };
		if (data.draft === true || data.prerelease === true || typeof data.tag_name !== "string") {
			return fallback;
		}
		const latestVersion = data.tag_name.trim().replace(/^v/i, "");
		if (!parseSemverTriplet(latestVersion)) return fallback;
		const releaseUrl =
			typeof data.html_url === "string" && data.html_url.startsWith("https://github.com/")
				? data.html_url
				: `https://github.com/${slug}/releases/tag/v${latestVersion}`;
		const result: ServerUpdateCheckResult = {
			currentVersion,
			latestVersion,
			updateAvailable: isNewerSemver(latestVersion, currentVersion),
			releaseUrl,
			checkedAt: new Date().toISOString(),
		};
		if (!options?.fetchImpl) {
			cachedResult = { expiresAt: Date.now() + CACHE_TTL_MS, value: result };
		}
		return result;
	} catch {
		return fallback;
	} finally {
		clearTimeout(timer);
	}
}
