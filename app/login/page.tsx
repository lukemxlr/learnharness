import { redirect } from "next/navigation";
import { LoginForm } from "@/components/login-form";
import { sanitizeNextPath } from "@/src/core";
import { getServerAuthState } from "../_lib/auth.ts";

export const dynamic = "force-dynamic";

export default async function LoginPage({
	searchParams,
}: {
	searchParams: Promise<{ next?: string }>;
}) {
	const { next } = await searchParams;
	const safeNext = sanitizeNextPath(next);
	const state = await getServerAuthState();
	if (!state.authRequired || state.authenticated) {
		redirect(safeNext);
	}
	return <LoginForm nextPath={safeNext} configured={state.configured} />;
}
