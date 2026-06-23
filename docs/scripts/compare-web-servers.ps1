# =============================================================
# 設備 :80 「兩個 web server」對照腳本
# 對多台設備各送 N 個相同的 GET /get/device/volume，
# 依 HTTP 回應的 Server 標頭統計：lgw_web(正常,200) vs hbi_web(403)。
# 執行（與設備同網段的 Windows，內建 curl 即可）：
#   powershell -ExecutionPolicy Bypass -File compare-web-servers.ps1
# =============================================================
$ips = @("192.168.0.147","192.168.0.148")   # ← 改成你要對照的設備
$N = 30
function Bar($n,$tot){ $w=22; if($tot -le 0){return ("-"*$w)}; $f=[math]::Round($n/$tot*$w); if($f -gt $w){$f=$w}; if($f -lt 0){$f=0}; return ("#"*$f)+("-"*($w-$f)) }

foreach($ip in $ips){
  $url = "http://$ip/get/device/volume"
  Write-Output "================================================================"
  Write-Output ("  DEVICE  " + $ip)
  Write-Output "================================================================"
  $pg = (Test-Connection -ComputerName $ip -Count 5 -ErrorAction SilentlyContinue | Measure-Object).Count
  $tc=0; for($i=0;$i -lt 5;$i++){ try{ $c=New-Object Net.Sockets.TcpClient; $a=$c.BeginConnect($ip,80,$null,$null); if($a.AsyncWaitHandle.WaitOne(2000)){$c.EndConnect($a);$tc++}; $c.Close() }catch{} }
  Write-Output ("  ICMP ping: $pg/5    TCP:80 connect: $tc/5")
  if($tc -eq 0){ Write-Output "  >>> not reachable on :80, skipping"; Write-Output ""; continue }

  $lgw=0;$hbi=0;$noresp=0;$other=0; $servers=@{}
  for($i=0;$i -lt $N;$i++){
    $hdr=(& curl.exe -s --noproxy "*" -D - -o NUL --max-time 6 $url 2>$null | Out-String)
    if($hdr -notmatch "HTTP/"){ $noresp++ }
    else{
      $srv = if($hdr -match "Server:\s*(\S+)"){$matches[1]}else{"(none)"}
      if($servers.ContainsKey($srv)){$servers[$srv]++}else{$servers[$srv]=1}
      if($srv -match "lgw"){$lgw++} elseif($srv -match "hbi"){$hbi++} else{$other++}
    }
    Start-Sleep -Milliseconds 200
  }
  Write-Output ("  $N identical GET /get/device/volume :")
  Write-Output ("    lgw_web (200 OK) : {0,2}/{1}  [{2}] {3}%" -f $lgw,$N,(Bar $lgw $N),[math]::Round($lgw/$N*100))
  Write-Output ("    hbi_web (403)    : {0,2}/{1}  [{2}] {3}%" -f $hbi,$N,(Bar $hbi $N),[math]::Round($hbi/$N*100))
  if($noresp -gt 0){ Write-Output ("    no response      : {0,2}/{1}" -f $noresp,$N) }
  Write-Output "  --- distinct Server headers returned ---"
  foreach($k in $servers.Keys){ Write-Output ("      " + $k + "  x" + $servers[$k]) }
  if($servers.Keys.Count -le 1){ Write-Output "    => ONLY ONE web server (OK)" } else { Write-Output "    => MULTIPLE web servers on :80 (defect)" }
  Write-Output ""
}
