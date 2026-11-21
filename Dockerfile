FROM node:22-alpine

WORKDIR /app
# Page, logos, photos, seed data, admin screen
COPY html/ ./html/
COPY server.js ./

ENV PORT=8080 DATA_DIR=/data NODE_ENV=production
# Runs as root so it can always write to the Unraid appdata folder (which Docker creates as root).
RUN mkdir -p /data
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/ >/dev/null || exit 1
CMD ["node", "server.js"]
