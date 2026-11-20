#!/bin/sh
# Downloads the Beckett product photos into html/photos/ (run from the repo folder).
# Beckett's site blocks cloud servers, so run this on your own computer.
set -e
cd "$(dirname "$0")/../html/photos"
UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36'
curl -fsS -A "$UA" -e https://www.beckettcorp.com/ -o beckett-af-afg.jpg 'https://www.beckettcorp.com/wp-content/uploads/2022/05/Beckett-AF-AFG-Burner-B100-UL-Listed-min-300x300.jpg' && echo 'ok  beckett-af-afg.jpg' || echo 'FAILED beckett-af-afg.jpg'
curl -fsS -A "$UA" -e https://www.beckettcorp.com/ -o beckett-rf.jpg 'https://www.beckettcorp.com/wp-content/uploads/2024/08/Beckett-RF-Burner-Left-Side-View-Air-Cover-Off-min-300x300.jpg' && echo 'ok  beckett-rf.jpg' || echo 'FAILED beckett-rf.jpg'
curl -fsS -A "$UA" -e https://www.beckettcorp.com/ -o beckett-nx.jpg 'https://www.beckettcorp.com/wp-content/uploads/2022/05/Beckett-NX-Oil-Burner-min-300x300.jpg' && echo 'ok  beckett-nx.jpg' || echo 'FAILED beckett-nx.jpg'
curl -fsS -A "$UA" -e https://www.beckettcorp.com/ -o beckett-sm.jpg 'https://www.beckettcorp.com/wp-content/uploads/2022/05/Beckett-SM-Oil-Burner-min-300x300.jpg' && echo 'ok  beckett-sm.jpg' || echo 'FAILED beckett-sm.jpg'
curl -fsS -A "$UA" -e https://www.beckettcorp.com/ -o beckett-sf.jpg 'https://www.beckettcorp.com/wp-content/uploads/2022/05/Beckett-SF-Oil-Burner-min-300x300.jpg' && echo 'ok  beckett-sf.jpg' || echo 'FAILED beckett-sf.jpg'
curl -fsS -A "$UA" -e https://www.beckettcorp.com/ -o beckett-adc.jpg 'https://www.beckettcorp.com/wp-content/uploads/2022/05/Beckett-ADC-Oil-Burner-min-300x300.jpg' && echo 'ok  beckett-adc.jpg' || echo 'FAILED beckett-adc.jpg'
curl -fsS -A "$UA" -e https://www.beckettcorp.com/ -o beckett-sdc.jpg 'https://www.beckettcorp.com/wp-content/uploads/2022/05/Beckett-SDC-Oil-Burner-min-300x300.jpg' && echo 'ok  beckett-sdc.jpg' || echo 'FAILED beckett-sdc.jpg'
curl -fsS -A "$UA" -e https://www.beckettcorp.com/ -o beckett-cf375.jpg 'https://www.beckettcorp.com/wp-content/uploads/2022/05/Beckett-CF375-Oil-Burner-min-300x300.jpg' && echo 'ok  beckett-cf375.jpg' || echo 'FAILED beckett-cf375.jpg'
curl -fsS -A "$UA" -e https://www.beckettcorp.com/ -o beckett-cf500.jpg 'https://www.beckettcorp.com/wp-content/uploads/2022/08/Beckett-CF500-Oil-Burner-min-300x300.jpg' && echo 'ok  beckett-cf500.jpg' || echo 'FAILED beckett-cf500.jpg'
curl -fsS -A "$UA" -e https://www.beckettcorp.com/ -o beckett-cf800.jpg 'https://www.beckettcorp.com/wp-content/uploads/2022/08/Beckett-CF800-Oil-Burner-min-300x300.jpg' && echo 'ok  beckett-cf800.jpg' || echo 'FAILED beckett-cf800.jpg'
curl -fsS -A "$UA" -e https://www.beckettcorp.com/ -o beckett-cf1000.jpg 'https://www.beckettcorp.com/wp-content/uploads/2022/05/Beckett-CF1000-Oil-Burner-min-300x300.jpg' && echo 'ok  beckett-cf1000.jpg' || echo 'FAILED beckett-cf1000.jpg'
curl -fsS -A "$UA" -e https://www.beckettcorp.com/ -o beckett-cf1400.jpg 'https://www.beckettcorp.com/wp-content/uploads/2022/05/Beckett-CF1400-Oil-Burner-min-300x300.jpg' && echo 'ok  beckett-cf1400.jpg' || echo 'FAILED beckett-cf1400.jpg'
curl -fsS -A "$UA" -e https://www.beckettcorp.com/ -o beckett-cf2300a.jpg 'https://www.beckettcorp.com/wp-content/uploads/2022/05/Beckett-CF2300-Oil-Burner-v2-min-300x300.jpg' && echo 'ok  beckett-cf2300a.jpg' || echo 'FAILED beckett-cf2300a.jpg'
curl -fsS -A "$UA" -e https://www.beckettcorp.com/ -o beckett-cf2500a.jpg 'https://www.beckettcorp.com/wp-content/uploads/2022/08/Beckett-CF2500A-Oil-Burner-min-300x300.jpg' && echo 'ok  beckett-cf2500a.jpg' || echo 'FAILED beckett-cf2500a.jpg'
curl -fsS -A "$UA" -e https://www.beckettcorp.com/ -o beckett-cf3500.jpg 'https://www.beckettcorp.com/wp-content/uploads/2022/08/Beckett-CF3500-Oil-Burner-min-300x300.jpg' && echo 'ok  beckett-cf3500.jpg' || echo 'FAILED beckett-cf3500.jpg'
curl -fsS -A "$UA" -e https://www.beckettcorp.com/ -o beckett-cg4.jpg 'https://www.beckettcorp.com/wp-content/uploads/2022/05/Beckett-CG4-Gas-Burner-min-300x300.jpg' && echo 'ok  beckett-cg4.jpg' || echo 'FAILED beckett-cg4.jpg'
curl -fsS -A "$UA" -e https://www.beckettcorp.com/ -o beckett-cg10.jpg 'https://www.beckettcorp.com/wp-content/uploads/2022/05/Beckett-CG10-Oil-Burner-min-300x300.jpg' && echo 'ok  beckett-cg10.jpg' || echo 'FAILED beckett-cg10.jpg'
curl -fsS -A "$UA" -e https://www.beckettcorp.com/ -o beckett-cg15.jpg 'https://www.beckettcorp.com/wp-content/uploads/2022/10/Beckett-CG15-Gas-Burner-560-to-1500-MBH-AC-Power-min-300x300.jpg' && echo 'ok  beckett-cg15.jpg' || echo 'FAILED beckett-cg15.jpg'
curl -fsS -A "$UA" -e https://www.beckettcorp.com/ -o beckett-cg25.jpg 'https://www.beckettcorp.com/wp-content/uploads/2022/10/Beckett-CG25-Gas-Burner-990-to-2700-MBH-AC-Power-min-300x300.jpg' && echo 'ok  beckett-cg25.jpg' || echo 'FAILED beckett-cg25.jpg'
curl -fsS -A "$UA" -e https://www.beckettcorp.com/ -o beckett-cg50.jpg 'https://www.beckettcorp.com/wp-content/uploads/2022/10/Beckett-CG50-Gas-Burner-1400-to-5000-MBH-AC-Power-min-300x300.jpg' && echo 'ok  beckett-cg50.jpg' || echo 'FAILED beckett-cg50.jpg'
