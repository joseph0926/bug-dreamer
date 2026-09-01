FROM node:24.16.0-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203 AS artifacts

RUN corepack install --global pnpm@11.17.0 && corepack enable pnpm

WORKDIR /target

COPY target/ ./

RUN pnpm install --frozen-lockfile --filter @firsttx/shared... --filter @firsttx/tx... --filter @firsttx/local-first... --filter @firsttx/prepaint...
RUN ["pnpm", "--filter", "@firsttx/shared", "build"]
RUN ["pnpm", "--filter", "@firsttx/tx", "build"]
RUN ["pnpm", "--filter", "@firsttx/local-first", "build"]
RUN ["pnpm", "--filter", "@firsttx/prepaint", "build"]
RUN mkdir /artifacts
RUN ["pnpm", "--filter", "@firsttx/shared", "pack", "--out", "/artifacts/shared.tgz"]
RUN ["pnpm", "--filter", "@firsttx/tx", "pack", "--out", "/artifacts/tx.tgz"]
RUN ["pnpm", "--filter", "@firsttx/local-first", "pack", "--out", "/artifacts/local-first.tgz"]
RUN ["pnpm", "--filter", "@firsttx/prepaint", "pack", "--out", "/artifacts/prepaint.tgz"]

FROM node:24.16.0-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203

ARG TARGET_REVISION
ARG REGISTRATION_SHA256

LABEL org.bug-dreamer.target-revision=$TARGET_REVISION
LABEL org.bug-dreamer.registration-sha256=$REGISTRATION_SHA256

RUN corepack install --global pnpm@11.17.0 && corepack enable pnpm

COPY --from=artifacts /artifacts /artifacts
COPY harness-v0.3 /harness-v0.3
COPY registrations/v0.3/packages.json /registration/packages.json

RUN mkdir /consumer && chown node:node /consumer
COPY harness-v0.3/probe-contracts.mjs /consumer/probe-contracts.mjs

USER node
WORKDIR /consumer

RUN node /harness-v0.3/create-consumer.mjs
RUN pnpm install --lockfile-only
RUN pnpm install --frozen-lockfile

ENTRYPOINT ["node", "/consumer/probe-contracts.mjs"]
