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
RUN apt-get update && apt-get install -y --no-install-recommends bash ca-certificates curl ffmpeg git poppler-utils python3-minimal python3-pip \
    && python3 -m pip install --break-system-packages --no-cache-dir genanki imageio openpyxl Pillow pypdf python-docx python-pptx reportlab \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /app /data /workspaces /home/node/.gemini \
    && chown -R node:node /app /data /workspaces /home/node/.gemini
WORKDIR /app
USER node
RUN curl -fsSL https://antigravity.google/cli/install.sh | bash
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node skill-catalog ./skill-catalog
EXPOSE 3000
CMD ["node", "dist/server.js"]
