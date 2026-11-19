export const DEFAULT_STREAM_KEEPALIVE_MS = 15_000;
export const MIN_STREAM_KEEPALIVE_MS = 50;
export const MAX_STREAM_KEEPALIVE_MS = 2_147_483_647;

export function resolveStreamKeepaliveMs(
	raw: string | undefined = process.env.LH_STREAM_KEEPALIVE_MS,
): number {
	const trimmed = raw?.trim();
	if (!trimmed || !/^\d+$/.test(trimmed)) return DEFAULT_STREAM_KEEPALIVE_MS;
	const parsed = Number(trimmed);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) return DEFAULT_STREAM_KEEPALIVE_MS;
	if (parsed < MIN_STREAM_KEEPALIVE_MS) return MIN_STREAM_KEEPALIVE_MS;
	if (parsed > MAX_STREAM_KEEPALIVE_MS) return MAX_STREAM_KEEPALIVE_MS;
	return parsed;
}
