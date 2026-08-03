# syntax=docker/dockerfile:1

FROM node:22.18.0-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    npm_config_update_notifier=false \
    COPSE_EVAL_ARTIFACT_DIR=/artifacts \
    ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    SKIP_BUNDLED_CURSOR_SKILLS_FETCH=1 \
    SKIP_ELECTRON_REBUILD=1 \
    SKIP_GORTEX_FETCH=1

RUN apt-get update && apt-get install -y --no-install-recommends \
      bubblewrap \
      build-essential \
      ca-certificates \
      git \
      python3 \
      ripgrep \
      socat \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --shell /bin/bash eval

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=optional --ignore-scripts --no-audit --no-fund \
    && npm rebuild node-pty

COPY packages ./packages
COPY scripts ./scripts
COPY src ./src
COPY tests/e2e/fixtures/synthetic-autonomy-executor.mjs ./tests/e2e/fixtures/
COPY tests/e2e/scenarios/autonomy-regression.json ./tests/e2e/scenarios/
RUN mkdir -p /artifacts /app/dist-test \
    && chown -R eval:eval /artifacts

USER eval

ENTRYPOINT ["npm", "run", "eval:autonomy:host", "--"]
