# Build from the repository root: docker build -f packages/server/Dockerfile .
# Official multi-architecture Bun image (linux/amd64 and linux/arm64).
FROM oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS base
WORKDIR /app
RUN bun --version && test "$(bun --version)" = "1.4.2"

FROM base AS build
COPY . .
RUN bun install --frozen-lockfile
RUN bun run generate \
    && bun build packages/server/src/main.ts --target=bun \
       --external @remote-tab/store-gcp --outdir=dist

# A fresh install prevents build-time tools from leaking into the runtime tree.
# Keep Bun's workspace and nested SDK dependency layout intact.
FROM base AS production
COPY . .
RUN bun install --frozen-lockfile --production \
    --filter remote-tab --filter @remote-tab/server \
    --filter @remote-tab/store-gcp --filter @remote-tab/protocol

FROM base AS runtime
ENV NODE_ENV=production PORT=8080 REMOTE_TAB_STORE=memory
COPY --from=build /app/dist ./dist
COPY --from=production /app/package.json ./package.json
COPY --from=production /app/node_modules ./node_modules
COPY --from=production /app/packages/store-gcp ./packages/store-gcp
COPY --from=production /app/packages/protocol ./packages/protocol
COPY --from=production /app/packages/server/package.json ./packages/server/package.json
COPY --from=production /app/packages/server/node_modules ./packages/server/node_modules
COPY --from=production /app/packages/server/src/store.ts ./packages/server/src/store.ts
COPY LICENSE ./LICENSE
# Importing the optional adapter checks its workspace/SDK resolution without ADC
# or any cloud request. The application itself imports it only for GCP mode.
RUN bun -e 'await import("@remote-tab/store-gcp"); for (const path of new Bun.Glob("**/typescript/package.json").scanSync({ cwd: "/app", dot: true })) throw new Error("Runtime contains TypeScript compiler: " + path)'
USER bun
EXPOSE 8080
CMD ["bun", "dist/main.js"]
