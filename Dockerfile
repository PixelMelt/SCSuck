FROM oven/bun:1-alpine

# FFmpeg for transcoding/probing, postgresql-client for pg_dump backups
RUN apk add --no-cache ffmpeg postgresql-client

WORKDIR /app

# Install dependencies first for layer caching
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Copy application source only (no local volumes/dumps)
COPY src ./src
COPY tsconfig.json ./

# Create data directories
RUN mkdir -p /data/temp /data/library /data/backups

ENV SCS_TEMP_DIR=/data/temp \
    SCS_LIBRARY_DIR=/data/library \
    SCS_BACKUP_DIR=/data/backups

# Run as non-root user for better security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup \
    && chown -R appuser:appgroup /app /data
USER appuser

CMD ["bun", "src/index.ts"]
