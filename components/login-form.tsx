"use client";

import { useState, type FormEvent } from "react";
import { sanitizeNextPath } from "@/src/core";

export function LoginForm({
	nextPath,
	configured,
}: {
	nextPath: string;
	configured: boolean;
}) {
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);

	async function handleSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (submitting) return;
		setError(null);
		setSubmitting(true);
		try {
			const res = await fetch("/api/auth/login", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ username: username.trim(), password }),
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { error?: string };
				setError(body.error ?? "Sign-in failed.");
				setSubmitting(false);
				return;
			}
			window.location.assign(sanitizeNextPath(nextPath));
		} catch {
			setError("Unable to reach the LearnHarness server. Try again.");
			setSubmitting(false);
		}
	}

	return (
		<main className="flex min-h-dvh items-center justify-center bg-background px-4 py-8 text-foreground">
			<div className="w-full max-w-sm rounded-xl border border-border bg-card p-6 shadow-lg">
				<h1 className="font-title text-xl font-semibold tracking-tight text-foreground">
					Sign in to LearnHarness
				</h1>
				<p className="mt-1.5 text-xs text-muted-foreground">
					Enter your server account credentials to continue.
				</p>

				{!configured && (
					<div
						role="alert"
						data-testid="login-unconfigured"
						className="mt-4 rounded-md border border-border bg-muted/50 px-3 py-2.5 text-xs text-foreground"
					>
						No server account is initialized yet. Run{" "}
						<code className="font-mono">node scripts/user-auth.mjs init --username &lt;name&gt;</code>{" "}
						on the server host.
					</div>
				)}

				<form onSubmit={(e) => void handleSubmit(e)} className="mt-5 flex flex-col gap-4">
					<div className="flex flex-col gap-1.5">
						<label htmlFor="lh-username" className="text-xs font-medium text-foreground">
							Username
						</label>
						<input
							id="lh-username"
							name="username"
							type="text"
							autoComplete="username"
							autoCapitalize="none"
							autoCorrect="off"
							required
							value={username}
							onChange={(e) => setUsername(e.target.value)}
							disabled={submitting}
							data-testid="login-username"
							className="min-h-[44px] w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-ring"
						/>
					</div>

					<div className="flex flex-col gap-1.5">
						<label htmlFor="lh-password" className="text-xs font-medium text-foreground">
							Password
						</label>
						<input
							id="lh-password"
							name="password"
							type="password"
							autoComplete="current-password"
							required
							value={password}
							onChange={(e) => setPassword(e.target.value)}
							disabled={submitting}
							data-testid="login-password"
							className="min-h-[44px] w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-ring"
						/>
					</div>

					{error && (
						<p role="alert" data-testid="login-error" className="text-xs text-error">
							{error}
						</p>
					)}

					<button
						type="submit"
						disabled={submitting || !configured}
						data-testid="login-submit"
						className="min-h-[44px] w-full cursor-pointer rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
					>
						{submitting ? "Signing in…" : "Sign in"}
					</button>
				</form>

				<p className="mt-4 text-[11px] leading-relaxed text-muted-foreground">
					Password resets are performed directly on the server using{" "}
					<code className="font-mono">scripts/user-auth.mjs reset-password</code>.
				</p>
			</div>
		</main>
	);
}
