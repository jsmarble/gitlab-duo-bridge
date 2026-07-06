# syntax=docker/dockerfile:1
# Multi-stage build: install deps, then minimal final image

# ---- Build stage ----
FROM oven/bun:1.2-alpine AS builder

WORKDIR /app

# Copy package files first for layer caching
COPY package.json bun.lock* ./

# Install dependencies (dev deps needed for types)
RUN bun install --frozen-lockfile

# Copy source
COPY tsconfig.json ./
COPY src/ ./src/

# Type-check at build time (fail fast)
RUN bun run typecheck

# ---- Runtime stage ----
FROM oven/bun:1.2-alpine AS runtime

WORKDIR /app

# Create non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Copy only what's needed to run
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src ./src

# Create data directory with correct ownership
RUN mkdir -p /data && chown appuser:appgroup /data

# Switch to non-root user
USER appuser

# Version stamped in at build time (defaults for local/dev builds).
# Set via: docker build --build-arg APP_VERSION=1.2.3
ARG APP_VERSION=0.0.0-dev
ENV APP_VERSION=$APP_VERSION

# Expose default port
EXPOSE 3000

# Health check — uses bun directly, no external binary dependency
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://localhost:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Environment defaults
ENV PORT=3000
ENV DATA_DIR=/data
ENV LOG_LEVEL=info

CMD ["bun", "src/index.ts"]
