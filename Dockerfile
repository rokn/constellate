# Constellate, one repository per container. The repo is cloned into /data
# on first start (see docker/entrypoint.sh); everything the app writes —
# groupings, notes, answers, voiced audio — lives under /data too.

FROM golang:1.26-bookworm AS gopls
# gopls powers go-to-definition and hovers in the code panel for Go repos.
RUN GOBIN=/out go install golang.org/x/tools/gopls@v0.24.0

FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run typecheck && npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git openssh-client ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
COPY --from=golang:1.26-bookworm /usr/local/go /usr/local/go
COPY --from=gopls /out/gopls /usr/local/bin/gopls
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json tsconfig.json ./
COPY server ./server
COPY shared ./shared
COPY public ./public
COPY docker/entrypoint.sh /usr/local/bin/constellate
ENV NODE_ENV=production \
    PORT=4317 \
    HOME=/data/home \
    CODEFLIGHT_CACHE_DIR=/data/cache \
    CODEFLIGHT_LOCK_REPO=1 \
    PATH=/usr/local/go/bin:$PATH \
    GOPATH=/data/go \
    GOTOOLCHAIN=auto
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 4317
ENTRYPOINT ["tini", "--", "constellate"]
