#!/bin/sh
# Runs when the container starts (nginx image runs /docker-entrypoint.d/*.sh).
# Downloads the official logos if they aren't already in the image. Never blocks startup.
d=/usr/share/nginx/html/logos
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36"
mkdir -p "$d"
get() {
  [ -s "$d/$1" ] && return 0
  if wget -q -T 15 -U "$UA" -O "$d/$1.tmp" "$2" && [ -s "$d/$1.tmp" ]; then
    mv "$d/$1.tmp" "$d/$1"; echo "logos: downloaded $1"
  else
    rm -f "$d/$1.tmp"; echo "logos: could not download $1 (page will show the brand name as text)"
  fi
}
get beckett.png https://www.beckettcorp.com/wp-content/uploads/2022/06/Beckett-logo-red-min.png
get wayne.svg   https://waynecombustion.com/media/Logos/WAY0415-Logo.svg
chmod -R a+rX "$d" 2>/dev/null
exit 0
