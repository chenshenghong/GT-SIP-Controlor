# =============================================================
# SIP 終端 Web 服務可靠性三層診斷腳本
# 用途：分層量測「網路 / TCP / HTTP」哪一層丟封包，定位丟連線根因。
# 執行：在與設備「同一台交換器/HUB、同網段」的 Windows 主機上，
#       PowerShell 執行：  powershell -ExecutionPolicy Bypass -File diag-http-reliability.ps1
# 需求：Windows 10/11 內建 PowerShell 即可，無需額外安裝。
# 注意：/get/device/volume 為免授權 GET，不會更動設備設定。
# =============================================================
$ip = "192.168.0.147"   # ← 改成待測設備 IP
$N  = 50                # 每層取樣次數

Write-Output ("目標設備: " + $ip + " | 每層取樣: " + $N + " 次")
Write-Output ""

# ---- Layer 1: ICMP（網路/實體層）----
Write-Output "=== Layer 1: ICMP 網路層 ==="
$p   = Test-Connection -ComputerName $ip -Count $N -ErrorAction SilentlyContinue
$got = ($p | Measure-Object).Count
$avg = if ($got) { [math]::Round((($p | Measure-Object ResponseTime -Average).Average), 2) } else { 0 }
$max = if ($got) { ($p | Measure-Object ResponseTime -Maximum).Maximum } else { 0 }
Write-Output ("  ping " + $got + "/" + $N + " 回應 (" + [math]::Round(($N-$got)/$N*100,1) + "% 丟失), avg " + $avg + "ms, max " + $max + "ms")
Write-Output ""

# ---- Layer 2: TCP :80 連線（傳輸層, kernel 處理）----
Write-Output "=== Layer 2: TCP :80 連線（kernel）==="
$ok = 0; $ms = @()
for ($i = 0; $i -lt $N; $i++) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  try {
    $c = New-Object Net.Sockets.TcpClient
    $iar = $c.BeginConnect($ip, 80, $null, $null)
    if ($iar.AsyncWaitHandle.WaitOne(2000)) { $c.EndConnect($iar); $ok++; $ms += $sw.ElapsedMilliseconds }
    $c.Close()
  } catch {}
}
$tavg = if ($ms.Count) { [math]::Round(($ms | Measure-Object -Average).Average, 0) } else { 0 }
Write-Output ("  TCP connect " + $ok + "/" + $N + " 成功, avg " + $tavg + "ms")
Write-Output ""

# ---- Layer 3: HTTP GET（應用層, 設備 web server）----
Write-Output "=== Layer 3: HTTP GET /get/device/volume（web server）==="
$hok = 0; $hto = 0; $hms = @()
for ($i = 0; $i -lt $N; $i++) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  try {
    $r = Invoke-WebRequest -Uri ("http://" + $ip + "/get/device/volume") -TimeoutSec 3 -UseBasicParsing
    if ($r.StatusCode -eq 200) { $hok++; $hms += $sw.ElapsedMilliseconds }
  } catch { $hto++ }
  Start-Sleep -Milliseconds 150   # 逐次、非並發
}
$hmin = if ($hms.Count) { ($hms | Measure-Object -Minimum).Minimum } else { 0 }
$havg = if ($hms.Count) { [math]::Round(($hms | Measure-Object -Average).Average, 0) } else { 0 }
$hmax = if ($hms.Count) { ($hms | Measure-Object -Maximum).Maximum } else { 0 }
Write-Output ("  HTTP 逐次 " + $hok + "/" + $N + " 成功, " + $hto + " 逾時/失敗")
Write-Output ("  成功延遲 min/avg/max = " + $hmin + "/" + $havg + "/" + $hmax + "ms")
Write-Output ""
Write-Output "判讀：若 L1/L2 接近 100% 而 L3 明顯偏低，則丟包發生在設備 HTTP 應用層（web server），非網路/TCP。"
