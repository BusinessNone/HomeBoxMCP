# Reconstructed from the running homeboxmcp image (node:22-alpine, /app/index.mjs).
# The original build context was lost; index.mjs was recovered from the image itself.
FROM node:22-alpine

ENV NODE_ENV=production

WORKDIR /app

# No dependencies to install: package.json is here for metadata and the npm scripts.
COPY package.json /app/package.json
COPY index.mjs /app/index.mjs

ENV PORT=3334 \
    CONFIG_PATH=/config/config.json \
    INBOX_PATH=/inbox \
    MAX_UPLOAD_MB=10

# node:22-alpine already ships an unprivileged `node` user (uid 1000).
# /config and /inbox are mount points; create them owned by node so a bind mount
# or a written config does not require root.
RUN mkdir -p /config /inbox \
 && chown -R node:node /app /config /inbox

USER node

EXPOSE 3334

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3334/healthz >/dev/null 2>&1 || exit 1

CMD ["node", "/app/index.mjs"]
