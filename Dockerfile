# syntax=docker/dockerfile:1

# ==============================================================================
# Stage 1: Build & Assets Compilation
# ==============================================================================
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Optimize Node memory and Playwright download behavior during build
ENV NODE_OPTIONS="--max-old-space-size=4096"
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Copy dependency manifests first for optimal Docker layer caching
COPY package.json package-lock.json* ./

# Install dependencies required for compiling the frontend and bundling the server
RUN npm ci || npm install --include=dev

# Copy complete application source
COPY . .

# Build Vite client SPA (dist/) and bundle Express server
RUN npm run build

# Download Chromium and headless-shell for web automation/testing
RUN npx playwright install chromium chromium-headless-shell && \
    chmod -R 777 /ms-playwright

# Remove devDependencies to minimize production image footprint
RUN npm prune --omit=dev


# ==============================================================================
# Stage 2: Production Runtime
# ==============================================================================
FROM node:22-bookworm-slim AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# ==============================================================================
# System dependencies for Playwright, Chromium and headless execution
# ==============================================================================
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    procps \
    xvfb \
    fonts-liberation \
    fonts-noto-color-emoji \
    fonts-freefont-ttf \
    && npx playwright install-deps chromium \
    && rm -rf /var/lib/apt/lists/*


# ==============================================================================
# Create runtime directories and browser-cache symlinks
# ==============================================================================
RUN mkdir -p \
    /app/data/artifacts \
    /app/data/project_backups \
    /app/public \
    /app/extension \
    /root/.cache \
    && chmod -R 777 /app/data \
    && ln -sfn /ms-playwright /tmp/ms-playwright \
    && ln -sfn /ms-playwright /root/.cache/ms-playwright


# ==============================================================================
# Copy compiled application and assets
# ==============================================================================
COPY --from=builder /app/dist ./dist

# Copy these directories only when they exist in the source repository.
# The application build must not fail just because /app/data is absent.
COPY --from=builder /app/public ./public
COPY --from=builder /app/extension ./extension

# Copy application JSON files when present in the builder stage.
COPY --from=builder /app/*.json ./


# ==============================================================================
# Pre-downloaded Playwright browser binaries
# ==============================================================================
COPY --from=builder /ms-playwright /ms-playwright


# ==============================================================================
# Runtime permissions and cache file
# ==============================================================================
RUN mkdir -p /app/data/artifacts /app/data/project_backups && \
    touch /app/ai_cache_store.json && \
    chmod -R 777 /app/data /ms-playwright && \
    chmod 666 /app/ai_cache_store.json


# ==============================================================================
# Container Networking
# ==============================================================================
EXPOSE 8080
EXPOSE 3000


# ==============================================================================
# Health Check
# ==============================================================================
HEALTHCHECK --interval=30s \
    --timeout=5s \
    --start-period=20s \
    --retries=3 \
    CMD node -e "require('http').get('http://127.0.0.1:' + (process.env.PORT || 8080) + '/api/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"


# ==============================================================================
# Start Production Server
# ==============================================================================
CMD ["node", "dist/server.cjs"]
