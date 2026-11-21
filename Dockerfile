FROM node:22-alpine

# Chromium renders RFQ PDFs on the server (for "Download PDF" and "Email PDF").
RUN apk add --no-cache chromium font-noto ttf-dejavu
ENV CHROMIUM_PATH=/usr/bin/chromium-browser

WORKDIR /app
# Page, logos, photos, seed data, admin screen
COPY html/ ./html/
COPY lib/ ./lib/
COPY server.js ./

ENV PORT=8080 DATA_DIR=/data NODE_ENV=production
# Runs as root so it can always write to the Unraid appdata folder (which Docker creates as root).
RUN mkdir -p /data
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/login >/dev/null || exit 1
CMD ["node", "server.js"]
