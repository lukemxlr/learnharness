# syntax=docker/dockerfile:1
# Dual-Node E2E Runner:
# - Node v20.16.0 (base image) runs @playwright/test@1.46.1 + WebKit 18.0 (/ms-playwright/webkit-2051)
# - Node v26.13.1 (/opt/node26/bin/node) runs LearnHarness Next.js standalone server & CLIs

FROM mcr.microsoft.com/playwright:noble

COPY --from=node:26-bookworm-slim /usr/local/bin/node /opt/node26/bin/node
COPY --from=node:26-bookworm-slim /usr/local/lib/node_modules /opt/node26/lib/node_modules

RUN ln -sf ../lib/node_modules/npm/bin/npm-cli.js /opt/node26/bin/npm \
 && ln -sf ../lib/node_modules/npm/bin/npx-cli.js /opt/node26/bin/npx \
 && chmod +x /opt/node26/bin/node /opt/node26/bin/npm /opt/node26/bin/npx \
 && mkdir -p /opt/e2e /work /artifacts

COPY package.json /opt/e2e/package.json

RUN cd /opt/e2e \
 && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --omit=dev --no-audit --no-fund \
 && npm cache clean --force

ENV NODE_PATH=/opt/e2e/node_modules \
    PATH="/opt/e2e/node_modules/.bin:$PATH" \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    LH_NODE26_BIN=/opt/node26/bin/node \
    LH_IGNORE_ENV_KEYS=1 \
    NEXT_TELEMETRY_DISABLED=1

WORKDIR /repo/tests/e2e
