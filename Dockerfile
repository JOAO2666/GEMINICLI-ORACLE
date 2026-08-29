FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PATH=/home/node/.local/bin:$PATH
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /app /data /home/node/.gemini \
    && chown -R node:node /app /data /home/node/.gemini
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
USER node
RUN curl -fsSL https://antigravity.google/cli/install.sh | bash
EXPOSE 3000
CMD ["node", "dist/server.js"]
