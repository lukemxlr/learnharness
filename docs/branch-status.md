# Branch Status — `feat/lxc-server-ipad-draw-migration`

Last updated: 2026-11-18T20:57:00Z

## Completed & Passed
- **M0**: Cloned `https://github.com/amosblomqvist/learnharness` (`cb25c8e`) into `repo/` on `feat/lxc-server-ipad-draw-migration`; verified Linux Docker images (`node:26-bookworm-slim`, `mcr.microsoft.com/playwright:noble`).
- **M1 Implementation (`F1`–`F5`)**: Implemented Docker test runner, `<LH_DATA_DIR>/attachments/<sha256>/` contract, loopback OpenAI test provider + synthetic fixtures, proxy trust + `/api/health` + systemd unit, single-account auth (`proxy.ts`, `user-auth.mjs`, `/login`, `user-auth.json*` standalone leak guards), and headless ChatGPT OAuth + resilient dynamic model catalog.
  - Passed in Linux Docker (`learnharness-test:node26`): `build-image`, `setup`, targeted M1 suites (`attachments-store` 4/4, `chatgpt-headless-catalog` 3/3, `chatgpt-stream` 11/11, `plugin-document-proxy` 8/8, `proxy-trust` 6/6, `user-auth` 5/5, `test-provider` 3/3), `typecheck`, `lint`, `build`, `smoke` (`smoke-provider-runtime`, `build-server`, `smoke-server --isolated`).
  - Partial full `npm test` run (`task-347`): 5,339/5,352 passed across 708 suites (8 timed out from unconstrained concurrency).
- **M-E2E-1 Scaffolding**: Created isolated Playwright WebKit harness (`tests/e2e/**`), synthetic fixtures (`tests/fixtures/e2e-synthetic/**`), and 64 Tier 1 specs; `--selfcheck` (4/4), `--list` (68), `--tier1 --list` (64), and 65-case WebKit geometry probe passed.

## Open / Still to Run
1. Re-run bounded `npm test` (`--test-concurrency=4`) in Docker and execute full **M1 Concurrent Verification Wave** (2 Reviewers, 2 Challengers, 1 Forensic Auditor — **open**).
2. Complete M-E2E-1 Verification Wave, then implement & run Tiers 2–4 (`TEST_READY.md` **open**).
3. Implement & verify **M2** (Migration), **M3** (Stream Handoff + Electron Remote), **M4** (Attachments + Drawing Pad), **M5** (iPad WebKit Matrix), **M6** (Final Gate Tiers 1–5 + R7 English Docs).
4. Open Windows VM & real iPad hardware tests (documented in `PROJECT.md`).

See `PROJECT.md` at repository root for full verified status, architecture contracts, and resume commands.
