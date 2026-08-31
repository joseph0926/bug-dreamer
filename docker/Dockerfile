FROM node:24.16.0-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203

ARG TARGET_REVISION
ARG DEPENDENCIES_REF

LABEL org.bug-dreamer.target-revision=$TARGET_REVISION
LABEL org.bug-dreamer.dependencies-ref=$DEPENDENCIES_REF

RUN corepack install --global pnpm@11.17.0 && corepack enable pnpm

WORKDIR /workspace

COPY target/package.json target/pnpm-lock.yaml target/pnpm-workspace.yaml target/tsconfig.base.json ./
COPY target/packages/shared/package.json packages/shared/package.json
COPY target/packages/tx/package.json packages/tx/package.json

RUN pnpm install --frozen-lockfile --filter @firsttx/tx...

COPY target/packages/shared packages/shared
COPY target/packages/tx packages/tx
COPY harness packages/tx/.bug-dreamer

RUN pnpm --filter @firsttx/shared build

USER node
WORKDIR /workspace/packages/tx

ENTRYPOINT ["node", "/workspace/packages/tx/.bug-dreamer/entrypoint.mjs"]
