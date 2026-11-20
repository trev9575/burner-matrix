# Downloads the Beckett product photos into html\photos (run from the repo folder in PowerShell).
$ErrorActionPreference='Continue'
$dest=Join-Path $PSScriptRoot '..\html\photos'
$h=@{ 'User-Agent'='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36'; 'Referer'='https://www.beckettcorp.com/' }
$list=@(
  @('beckett-af-afg.jpg','https://www.beckettcorp.com/wp-content/uploads/2022/05/Beckett-AF-AFG-Burner-B100-UL-Listed-min-300x300.jpg'),
  @('beckett-rf.jpg','https://www.beckettcorp.com/wp-content/uploads/2024/08/Beckett-RF-Burner-Left-Side-View-Air-Cover-Off-min-300x300.jpg'),
  @('beckett-nx.jpg','https://www.beckettcorp.com/wp-content/uploads/2022/05/Beckett-NX-Oil-Burner-min-300x300.jpg'),
  @('beckett-sm.jpg','https://www.beckettcorp.com/wp-content/uploads/2022/05/Beckett-SM-Oil-Burner-min-300x300.jpg'),
  @('beckett-sf.jpg','https://www.beckettcorp.com/wp-content/uploads/2022/05/Beckett-SF-Oil-Burner-min-300x300.jpg'),
  @('beckett-adc.jpg','https://www.beckettcorp.com/wp-content/uploads/2022/05/Beckett-ADC-Oil-Burner-min-300x300.jpg'),
  @('beckett-sdc.jpg','https://www.beckettcorp.com/wp-content/uploads/2022/05/Beckett-SDC-Oil-Burner-min-300x300.jpg'),
  @('beckett-cf375.jpg','https://www.beckettcorp.com/wp-content/uploads/2022/05/Beckett-CF375-Oil-Burner-min-300x300.jpg'),
  @('beckett-cf500.jpg','https://www.beckettcorp.com/wp-content/uploads/2022/08/Beckett-CF500-Oil-Burner-min-300x300.jpg'),
  @('beckett-cf800.jpg','https://www.beckettcorp.com/wp-content/uploads/2022/08/Beckett-CF800-Oil-Burner-min-300x300.jpg'),
  @('beckett-cf1000.jpg','https://www.beckettcorp.com/wp-content/uploads/2022/05/Beckett-CF1000-Oil-Burner-min-300x300.jpg'),
  @('beckett-cf1400.jpg','https://www.beckettcorp.com/wp-content/uploads/2022/05/Beckett-CF1400-Oil-Burner-min-300x300.jpg'),
  @('beckett-cf2300a.jpg','https://www.beckettcorp.com/wp-content/uploads/2022/05/Beckett-CF2300-Oil-Burner-v2-min-300x300.jpg'),
  @('beckett-cf2500a.jpg','https://www.beckettcorp.com/wp-content/uploads/2022/08/Beckett-CF2500A-Oil-Burner-min-300x300.jpg'),
  @('beckett-cf3500.jpg','https://www.beckettcorp.com/wp-content/uploads/2022/08/Beckett-CF3500-Oil-Burner-min-300x300.jpg'),
  @('beckett-cg4.jpg','https://www.beckettcorp.com/wp-content/uploads/2022/05/Beckett-CG4-Gas-Burner-min-300x300.jpg'),
  @('beckett-cg10.jpg','https://www.beckettcorp.com/wp-content/uploads/2022/05/Beckett-CG10-Oil-Burner-min-300x300.jpg'),
  @('beckett-cg15.jpg','https://www.beckettcorp.com/wp-content/uploads/2022/10/Beckett-CG15-Gas-Burner-560-to-1500-MBH-AC-Power-min-300x300.jpg'),
  @('beckett-cg25.jpg','https://www.beckettcorp.com/wp-content/uploads/2022/10/Beckett-CG25-Gas-Burner-990-to-2700-MBH-AC-Power-min-300x300.jpg'),
  @('beckett-cg50.jpg','https://www.beckettcorp.com/wp-content/uploads/2022/10/Beckett-CG50-Gas-Burner-1400-to-5000-MBH-AC-Power-min-300x300.jpg')
)
foreach($p in $list){ try { Invoke-WebRequest -Uri $p[1] -Headers $h -OutFile (Join-Path $dest $p[0]); Write-Host ('ok  '+$p[0]) } catch { Write-Host ('FAILED '+$p[0]) } }
