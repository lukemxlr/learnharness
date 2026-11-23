# Security policy

LearnHarness stores API keys, sign-in tokens, chats, and learning records on your server or machine, and its agent reads files and fetches web content on your behalf. If you find a security vulnerability in this fork, please report it privately so a fix can ship before details are public.

## Reporting a vulnerability

**Do not open a public issue or pull request for a security problem.**

Report it through GitHub's private vulnerability reporting:
[Security → Report a vulnerability](https://github.com/lukemxlr/learnharness/security/advisories/new).

If the issue originates in upstream LearnHarness rather than this fork's server/iPad/remote-client extensions, please also consider notifying the upstream repository (`amosblomqvist/learnharness`) through its private security advisory channel.

A useful report includes:

- the LearnHarness version and your OS / deployment setup (desktop vs. self-hosted server);
- what an attacker can do and what they need first (a web page the agent reads, a file the learner opens, network access, reverse-proxy headers, and so on);
- steps to reproduce, or a proof of concept;
- any fix or mitigation you have in mind.

## Security contact

- [@lukemxlr](https://github.com/lukemxlr)

Use the private reporting process above for vulnerability reports. Do not disclose security details in public mentions or issues.

## Supported versions

Only the latest release on `main` receives security fixes. If you run the self-hosted server, update from the latest release tarball or `main`.

## Scope

In scope:

- the desktop app (Electron shell, remote-client isolation, window, and IPC);
- the self-hosted / local API server, single-account authentication (`/login`, `lh_session`), host/proxy header validation, and attachment storage;
- the agent and its tools, including prompt injection from web pages, PDFs, or other content that leads to reading, changing, or sending your data;
- rendered content such as demos, figures, drawing exports, and markdown;
- the update and release pipeline.

Out of scope:

- attacks that already require running code as your OS or server user;
- bugs in third-party model or service providers themselves (report those to the provider);
- automated scanner output without a demonstrated impact on LearnHarness.
