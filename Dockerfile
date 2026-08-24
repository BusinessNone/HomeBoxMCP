# Reconstructed from the running homebox-shim image (node:22-alpine, /app/index.mjs).
# The original build context was lost; index.mjs was recovered from the image itself.
FROM node:22-alpine

WORKDIR /app
COPY index.mjs /app/index.mjs

ENV PORT=3334 \
    CONFIG_PATH=/config/config.json \
    INBOX_PATH=/inbox \
    MAX_UPLOAD_MB=10

EXPOSE 3334

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3334/healthz >/dev/null 2>&1 || exit 1

CMD ["node", "/app/index.mjs"]
