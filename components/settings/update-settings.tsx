"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { BrailleSpinner } from "@/components/braille-spinner";
import { SettingsRow, Toggle } from "./controls.tsx";

/** Observational snapshot from electron/main.cjs; never updater permission. */
export type UpdateState = {
	status: "idle" | "checking" | "downloading" | "up-to-date" | "downloaded" | "error" | "disabled";
	version: string | null;
	revision: number;
};

export const APP_VERSION = process.env.LH_VERSION ?? "";
const HOMEPAGE = process.env.LH_HOMEPAGE ?? "";
export const MANUAL_UPDATE_HINT = "Checking downloads available updates. Downloaded updates install when you quit the app.";
export const AUTO_UPDATE_HINT = "Check at startup and every 24 hours. Turning this off does not stop updates already in progress or ready to install.";
const UPDATE_ERROR = "Couldn’t check for updates. Try again later.";

/** Subscribe before requesting the snapshot. IPC replies and pushes can
 * cross; a revision prevents an older reply from hiding a newer event.
 * The banner shares this read-only observer so late loads recover too. */
export function useUpdateState() {
	const [state, setState] = useState<UpdateState | null>(null);
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		const lh = window.lh;
		if (!lh) return;
		let live = true;
		let revision = -1;
		const accept = (next: UpdateState) => {
			if (!live || next.revision < revision) return;
			revision = next.revision;
			setState(next);
			setFailed(false);
		};
		const off = lh.onUpdateStatus?.(accept);
		void lh.getUpdateState?.().then(accept).catch(() => {
			if (live && revision === -1) setFailed(true);
		});
		return () => { live = false; off?.(); };
	}, []);
	return { state, failed };
}

export function updateStatusText(state: UpdateState | null): string | null {
	switch (state?.status) {
		case "checking": return "Checking for updates…";
		case "downloading": return state.version ? `Downloading version ${state.version}…` : "Downloading an update…";
		case "up-to-date": return "No newer version was found at the last check.";
		case "downloaded": return `${state.version ? `Version ${state.version}` : "An update"} is ready. It will install when you quit the app.`;
		case "error": return UPDATE_ERROR;
		default: return null;
	}
}

export interface ServerUpdateInfo {
	currentVersion: string;
	latestVersion: string | null;
	updateAvailable: boolean;
	releaseUrl: string | null;
}

/** Version information is useful everywhere; update controls only belong
 * to a shell with an available updater. Opening this row never checks. */
export function UpdateSettings({
	autoUpdate,
	onAutoUpdateChange,
	version = APP_VERSION,
	homepage = HOMEPAGE,
}: {
	autoUpdate: boolean;
	onAutoUpdateChange: (on: boolean) => void;
	version?: string;
	homepage?: string;
}) {
	const { state, failed } = useUpdateState();
	const [isRemoteDesktop, setIsRemoteDesktop] = useState(false);
	const [desktopVersion, setDesktopVersion] = useState<string | null>(null);
	const [remoteAutoUpdate, setRemoteAutoUpdate] = useState<boolean | null>(null);
	const [mountedClient, setMountedClient] = useState(false);
	const [serverCheckBusy, setServerCheckBusy] = useState(false);
	const [serverUpdate, setServerUpdate] = useState<ServerUpdateInfo | null>(null);

	useEffect(() => {
		setMountedClient(true);
		let live = true;
		const remote = Boolean(window.lh?.isRemoteMode);
		setIsRemoteDesktop(remote);
		if (remote && typeof window.lh?.getAppVersion === "function") {
			void window.lh.getAppVersion().then((v) => {
				if (live && typeof v === "string" && v.trim()) setDesktopVersion(v.trim());
			}).catch(() => {});
		}
		if (remote && typeof window.lh?.getAutoUpdate === "function") {
			void window.lh.getAutoUpdate().then((v) => {
				if (live && typeof v === "boolean") setRemoteAutoUpdate(v);
			}).catch(() => {});
		}
		return () => { live = false; };
	}, []);
	const [checkFailed, setCheckFailed] = useState(false);
	useEffect(() => setCheckFailed(false), [state]);
	const active = state !== null && state.status !== "disabled";
	const busy = state?.status === "checking" || state?.status === "downloading";
	const status = state?.status === "downloaded" ? updateStatusText(state)
		: failed || checkFailed ? UPDATE_ERROR : updateStatusText(state);
	const releaseTagVersion = (isRemoteDesktop ? desktopVersion : null) || version;
	const releaseNotes = releaseTagVersion && homepage ? `${homepage}/releases/tag/v${releaseTagVersion}` : null;

	const checkServerVersion = () => {
		setServerCheckBusy(true);
		void fetch("/api/version/latest", { cache: "no-store" })
			.then((r) => (r.ok ? (r.json() as Promise<ServerUpdateInfo>) : null))
			.then((info) => {
				if (info && typeof info.currentVersion === "string") setServerUpdate(info);
			})
			.catch(() => {})
			.finally(() => setServerCheckBusy(false));
	};

	const check = () => {
		setCheckFailed(false);
		void window.lh?.checkForUpdates?.().catch(() => setCheckFailed(true));
		if (isRemoteDesktop) checkServerVersion();
	};

	const effectiveAutoUpdate = isRemoteDesktop && remoteAutoUpdate !== null ? remoteAutoUpdate : autoUpdate;
	const handleAutoUpdateToggle = (on: boolean) => {
		if (isRemoteDesktop && typeof window.lh?.setAutoUpdate === "function") {
			setRemoteAutoUpdate(on);
			void window.lh.setAutoUpdate(on).then((saved) => {
				if (typeof saved === "boolean") setRemoteAutoUpdate(saved);
			}).catch(() => {});
			return;
		}
		onAutoUpdateChange(on);
	};

	const showWebServerCheck = mountedClient && !active && !isRemoteDesktop && typeof window !== "undefined" && !window.lh;
	const rowLabel = isRemoteDesktop
		? `Desktop app ${desktopVersion || version || "unknown"}`
		: `Version ${version || "unknown"}`;

	return (
		<>
			<SettingsRow
				label={rowLabel}
				testid="row-version"
				hint={
					<>
						{isRemoteDesktop && version && (
							<span className="block text-muted-foreground" data-testid="server-version-line">
								Server {version}
							</span>
						)}
						{status && <span className="block" role="status" data-testid="update-status">{status}</span>}
						{serverUpdate?.updateAvailable && serverUpdate.latestVersion && (
							<span className="mt-1 block text-foreground" role="status" data-testid="server-update-notice">
								Server update available (v{serverUpdate.latestVersion}). Run{" "}
								<code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
									sudo bash /opt/learnharness/src/scripts/update-server.sh
								</code>{" "}
								on your server.
							</span>
						)}
						{!isRemoteDesktop && serverUpdate && !serverUpdate.updateAvailable && serverUpdate.latestVersion && (
							<span className="block" role="status" data-testid="server-update-notice">
								Server is up to date (v{serverUpdate.latestVersion}).
							</span>
						)}
						{active && <span className="block">{MANUAL_UPDATE_HINT}</span>}
						{!active && state?.status === "disabled" && typeof window !== "undefined" && window.lh?.platform === "darwin" && (
							<span className="block" data-testid="mac-manual-update-hint">
								Unsigned macOS builds update manually by downloading the latest .dmg from GitHub Releases.
							</span>
						)}
						{releaseNotes && <a href={releaseNotes} target="_blank" rel="noopener noreferrer" className="underline-offset-2 hover:text-foreground hover:underline" data-testid="release-notes">Release notes</a>}
					</>
				}
			>
				{active ? (state.status === "downloaded" ? (
					<Button type="button" size="xs" className="cursor-pointer" data-testid="update-restart" onClick={() => window.lh?.installUpdate?.()}>Restart</Button>
				) : (
					<Button type="button" size="xs" variant="outline" className="cursor-pointer disabled:cursor-not-allowed" data-testid="update-check" disabled={busy} aria-busy={busy} onClick={check}>
						{busy && <BrailleSpinner label={state.status === "downloading" ? "Downloading update" : "Checking for updates"} />}
						Check for updates
					</Button>
				)) : showWebServerCheck ? (
					<Button
						type="button"
						size="xs"
						variant="outline"
						className="cursor-pointer disabled:cursor-not-allowed"
						data-testid="server-update-check"
						disabled={serverCheckBusy}
						aria-busy={serverCheckBusy}
						onClick={checkServerVersion}
					>
						{serverCheckBusy && <BrailleSpinner label="Checking for server updates" />}
						Check for updates
					</Button>
				) : null}
			</SettingsRow>
			{active && (
				<SettingsRow label="Automatic updates" hint={AUTO_UPDATE_HINT} testid="row-auto-update">
					<Toggle checked={effectiveAutoUpdate} label="auto update" onChange={handleAutoUpdateToggle} />
				</SettingsRow>
			)}
		</>
	);
}
