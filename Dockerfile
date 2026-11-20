FROM nginx:1.27-alpine

# The page (and any logo files committed to html/logos/)
COPY html/ /usr/share/nginx/html/

# Logo sites block cloud build servers, so logos are fetched when the container
# starts on your server instead. Committed files in html/logos/ are used as-is.
COPY docker/40-fetch-logos.sh /docker-entrypoint.d/40-fetch-logos.sh
RUN chmod +x /docker-entrypoint.d/40-fetch-logos.sh && chmod -R a+rX /usr/share/nginx/html

EXPOSE 80
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1
