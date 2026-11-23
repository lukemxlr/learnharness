# Contributing

Bug reports, focused fixes, documentation improvements, reviews, and tests are welcome!

This repository is an independent fork of [LearnHarness](https://github.com/amosblomqvist/learnharness) focused on self-hosted Linux / Proxmox LXC deployment, multi-device live-stream handoff, iPadOS Safari + Apple Pencil Drawing Pad ergonomics, unified attachments, headless ChatGPT Plus OAuth, and an isolated remote desktop client.

## Before starting

Check existing issues and PRs before starting larger work:

- [Issues](https://github.com/lukemxlr/learnharness/issues): bug reports and concrete implementation work.
- [Releases](https://github.com/lukemxlr/learnharness/releases): current published desktop and server builds.

If a fix or feature belongs to core upstream LearnHarness rather than this fork's self-hosted / iPad / remote-client capabilities, consider contributing upstream to [`amosblomqvist/learnharness`](https://github.com/amosblomqvist/learnharness) as well.

## Pull requests

- **Keep each PR focused on one coherent problem.** Include tests and documentation needed for that change, and respect the 4-zone import boundaries enforced by [`eslint.config.mjs`](eslint.config.mjs).
- **Explain clearly:**
  - The problem (linking any relevant issue).
  - What changed and why.
  - How you verified it (commands run, real vs. mocked providers, and any limitations).
- **Never commit secrets or private data:** Do not publish credentials, tokens, `.env` files, personal domains/IPs, private learning records, or private course materials. Use synthetic fixtures only.

## Verification

See the [Development guide](docs/development.md) and [Developer handover](docs/developer-handover.md) for local and Docker test commands (`npm run typecheck`, `npm run lint`, `npm test`, `plugins/drawing-pad` tests, and Playwright WebKit E2E).

## License

All contributions are licensed under **[GNU AGPL-3.0-only](LICENSE)**, matching upstream LearnHarness.
