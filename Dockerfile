# observe-agents-do-things — runs the observer + web UI in a container.
# Your agent transcripts are mounted read-only (see docker-compose.yml).
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
COPY examples ./examples
COPY scripts ./scripts
RUN npm ci --no-audit --no-fund
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
# Transcripts are expected at these paths (mount them read-only).
ENV CLAUDE_CONFIG_DIR=/data/claude CODEX_HOME=/data/codex
EXPOSE 4545
USER node
# Bind all interfaces inside the container; publish the port on 127.0.0.1 only.
ENTRYPOINT ["node", "packages/server/dist/cli.js"]
CMD ["--host", "0.0.0.0", "--port", "4545", "--no-auth"]
