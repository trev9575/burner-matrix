FROM nginx:1.27-alpine

# The page
COPY html/ /usr/share/nginx/html/

# Official logos, pulled from each maker's website at build time
ADD https://www.beckettcorp.com/wp-content/uploads/2022/06/Beckett-logo-red-min.png /usr/share/nginx/html/logos/beckett.png
ADD https://waynecombustion.com/media/Logos/WAY0415-Logo.svg /usr/share/nginx/html/logos/wayne.svg

# ADD from a URL saves files owner-only; let nginx read them
RUN chmod -R a+rX /usr/share/nginx/html

EXPOSE 80
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1
