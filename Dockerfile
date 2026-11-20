FROM nginx:1.27-alpine

# The page
COPY html/ /usr/share/nginx/html/

# Official logos, pulled from each maker's website at build time.
# If a site refuses the download, the page falls back to text names instead of failing the build.
# Logo files committed to html/logos/ are kept and not overwritten.
ARG UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36"
RUN set -e; d=/usr/share/nginx/html/logos; mkdir -p "$d"; \
    get() { [ -s "$d/$1" ] && return 0; \
      wget -q -T 20 -U "$UA" --header="Accept: image/avif,image/webp,image/png,image/svg+xml,*/*" -O "$d/$1" "$2" \
        && echo "logo ok: $1" || { rm -f "$d/$1"; echo "WARNING: could not download $1 from $2"; }; }; \
    get beckett.png https://www.beckettcorp.com/wp-content/uploads/2022/06/Beckett-logo-red-min.png; \
    get wayne.svg   https://waynecombustion.com/media/Logos/WAY0415-Logo.svg; \
    chmod -R a+rX /usr/share/nginx/html

EXPOSE 80
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1
