import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { sanitizeNextPath, type SessionStatusResponse } from "@/src/core";
import { USER_AUTH_COOKIE_NAME, verifyCookieValue } from "@/src/server";

export async function getServerAuthState(): Promise<SessionStatusResponse> {
	const cookieStore = await cookies();
	const token = cookieStore.get(USER_AUTH_COOKIE_NAME)?.value;
	return verifyCookieValue(token);
}

export async function requirePageAuth(nextPath: string): Promise<SessionStatusResponse> {
	const state = await getServerAuthState();
	if (state.authRequired && !state.authenticated) {
		const safeNext = sanitizeNextPath(nextPath);
		redirect(`/login?next=${encodeURIComponent(safeNext)}`);
	}
	return state;
}
