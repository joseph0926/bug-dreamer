FROM node:24.16.0-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203

ARG TARGET_REVISION
ARG DEPENDENCIES_REF
ARG MODULE_DIR
ARG MODULE_FILTER
ARG BUILD_FILTERS

LABEL org.bug-dreamer.target-revision=$TARGET_REVISION
LABEL org.bug-dreamer.dependencies-ref=$DEPENDENCIES_REF
LABEL org.bug-dreamer.module=$MODULE_DIR

RUN corepack install --global pnpm@11.17.0 && corepack enable pnpm

WORKDIR /workspace

COPY target/ ./

RUN pnpm install --frozen-lockfile --filter "${MODULE_FILTER}..."

COPY harness ${MODULE_DIR}/.bug-dreamer

RUN [ -z "$BUILD_FILTERS" ] || for f in $BUILD_FILTERS; do pnpm --filter "$f" build || exit 1; done

ENV BUG_DREAMER_MODULE_DIR=/workspace/${MODULE_DIR}

USER node
WORKDIR /workspace/${MODULE_DIR}

ENTRYPOINT ["node", ".bug-dreamer/entrypoint.mjs"]
