import { defineConfig } from "@playwright/test";

const artifactsRoot = process.env.LH_E2E_ARTIFACTS_DIR || "/artifacts";
const workersEnv = Number(process.env.LH_E2E_WORKERS || "1");
const workers = Number.isInteger(workersEnv) && workersEnv > 0 ? workersEnv : 1;

export default defineConfig({
	testDir: "./specs",
	testMatch: "**/*.spec.mjs",
	timeout: 60_000,
	expect: {
		timeout: 10_000,
	},
	fullyParallel: false,
	workers,
	forbidOnly: Boolean(process.env.CI),
	retries: 0,
	outputDir: `${artifactsRoot}/test-results`,
	reporter: [
		["list"],
		["html", { open: "never", outputFolder: `${artifactsRoot}/html-report` }],
	],
	use: {
		browserName: "webkit",
		headless: true,
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
		video: "off",
		actionTimeout: 15_000,
		navigationTimeout: 30_000,
	},
	projects: [
		{
			name: "webkit",
			use: {
				browserName: "webkit",
				headless: true,
			},
		},
	],
});
