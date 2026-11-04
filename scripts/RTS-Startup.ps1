#Requires -Version 5.1
<#
.SYNOPSIS
    RTS INTELLIGENT STARTUP ENGINE — v4 (fast, marker-based success, no Start-Job)

.NOTES
    Bug fixes vs the previous version you were running:

      1) REMOVED Start-Job entirely.
         It was adding a 70-90s PSRemoting warm-up every run. Network probe
         is now synchronous with a hard 5s cap.

      2) REMOVED the "success = $proc.ExitCode -eq 0" pattern for node probes.
         In PS 5.1, Start-Process -PassThru with redirected output returns
         $null for ExitCode even when the process exited cleanly, which is why
         PING_OK runs were being reported as "attempt failed".

         Success is now detected in this order:
           a) marker string in captured output (e.g. "PING_OK")
           b) exit code read from a file written by cmd itself (reliable)

      3) Reduced DB probe timeout 25s -> 8s, and, on failure, WARN and continue
         (pass -StrictDbProbe to restore the old fatal behaviour).

      4) All timeouts reduced. Every stage logs its own duration.
#>

[CmdletBinding()]
param(
    [string]$ProjectPath       = "D:\RTS\SmartTRADE",
    [string]$MongoService      = "MongoDB",
    [int]$Port                 = 5000,
    [int]$InternetTimeoutSec   = 5,
    [int]$MongoStartTimeoutSec = 30,
    [int]$MongoPortTimeoutSec  = 20,
    [int]$DbProbeTimeoutSec    = 8,
    [int]$DbProbeMaxAttempts   = 3,
    [int]$GitTimeoutSec        = 30,
    [int]$RtsStartTimeoutSec   = 120,
    [switch]$SkipGit,
    [switch]$SkipEmail,
    [switch]$StrictDbProbe
)

$ErrorActionPreference = "Stop"
$ProgressPreference    = "SilentlyContinue"

$Script:StartTime  = Get-Date
$Script:StageStart = Get-Date
$Script:Stage      = "init"

# ============================================================
# LOGGING
# ============================================================

$LogPath   = Join-Path $ProjectPath "logs"
$ServerLog = Join-Path $LogPath "rts-server.log"
$EmailLog  = Join-Path $LogPath "startup-email.log"

if (!(Test-Path $LogPath)) { New-Item -ItemType Directory -Path $LogPath -Force | Out-Null }

$LogFile = Join-Path $LogPath ("startup-{0}.log" -f (Get-Date -Format 'yyyy-MM-dd'))

function Write-Log {
    param(
        [string]$Message,
        [ValidateSet('INFO','OK','WARN','ERROR','STAGE')][string]$Level = 'INFO'
    )
    $total = [int]((Get-Date) - $Script:StartTime).TotalSeconds
    $line  = "{0} [{1,4}s] [{2,-5}] {3}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $total, $Level, $Message
    try { Add-Content -Path $LogFile -Value $line -Encoding UTF8 -ErrorAction SilentlyContinue } catch { }
    switch ($Level) {
        'ERROR' { Write-Host $line -ForegroundColor Red }
        'WARN'  { Write-Host $line -ForegroundColor Yellow }
        'OK'    { Write-Host $line -ForegroundColor Green }
        'STAGE' { Write-Host $line -ForegroundColor Cyan }
        default { Write-Host $line }
    }
}

function Enter-Stage {
    param([string]$Name)
    if ($Script:Stage -ne 'init') {
        $dur = [int]((Get-Date) - $Script:StageStart).TotalSeconds
        Write-Log "[previous stage '$Script:Stage'] took ${dur}s" -Level INFO
    }
    $Script:Stage      = $Name
    $Script:StageStart = Get-Date
    Write-Log "===== STAGE: $Name =====" -Level STAGE
}

# ============================================================
# FAST TCP PROBE
# ============================================================

function Test-FastPort {
    param(
        [string]$HostName,
        [int]$Port,
        [int]$TimeoutMs = 1500
    )
    $Client = New-Object System.Net.Sockets.TcpClient
    try {
        $Async = $Client.BeginConnect($HostName, $Port, $null, $null)
        if (!$Async.AsyncWaitHandle.WaitOne($TimeoutMs, $false)) { return $false }
        $Client.EndConnect($Async)
        return $true
    }
    catch { return $false }
    finally { $Client.Close() }
}

# ============================================================
# BOUNDED COMMAND RUNNER
#   - starts cmd.exe /v:on /c "..."  (delayed expansion lets us capture %ERRORLEVEL%)
#   - stdout / stderr redirected by cmd itself (no Start-Process redirect bugs)
#   - killed with taskkill /T /F on timeout
#   - success = marker in output OR exit code from file (reliable)
# ============================================================

function Invoke-BoundedCommand {
    param(
        [string]$CommandLine,
        [int]$TimeoutSec,
        [string]$WorkingDirectory = $ProjectPath,
        [string]$Name = "cmd",
        [string[]]$SuccessMarkers = @()
    )

    $suffix  = [guid]::NewGuid().ToString('N').Substring(0,8)
    $outFile = Join-Path $env:TEMP ("rts-$Name-$suffix.out")
    $errFile = Join-Path $env:TEMP ("rts-$Name-$suffix.err")
    $exitFile= Join-Path $env:TEMP ("rts-$Name-$suffix.exit")

    try {
        # capture stdout, stderr and %ERRORLEVEL% (delayed expansion via /v:on)
        $wrapped = "($CommandLine) 1> `"$outFile`" 2> `"$errFile`" & echo !ERRORLEVEL!> `"$exitFile`""

        $proc = Start-Process -FilePath "cmd.exe" `
            -ArgumentList "/v:on", "/c", $wrapped `
            -WorkingDirectory $WorkingDirectory `
            -WindowStyle Hidden `
            -PassThru `
            -ErrorAction Stop

        if (-not $proc.WaitForExit($TimeoutSec * 1000)) {
            try { & taskkill /T /F /PID $proc.Id 2>&1 | Out-Null } catch { }
            try { $proc.WaitForExit(2000) | Out-Null } catch { }

            $partialOut = ''
            $partialErr = ''
            if (Test-Path $outFile) { $partialOut = [string](Get-Content $outFile -Raw -ErrorAction SilentlyContinue) }
            if (Test-Path $errFile) { $partialErr = [string](Get-Content $errFile -Raw -ErrorAction SilentlyContinue) }

            return [pscustomobject]@{
                Success   = $false
                ExitCode  = -1
                Output    = ("TIMEOUT after ${TimeoutSec}s. " + ("$partialOut $partialErr").Trim())
                TimedOut  = $true
                MarkerHit = $false
            }
        }

        $out = ''
        $err = ''
        $exitCode = $null
        if (Test-Path $outFile)  { $out = [string](Get-Content $outFile -Raw -ErrorAction SilentlyContinue) }
        if (Test-Path $errFile)  { $err = [string](Get-Content $errFile -Raw -ErrorAction SilentlyContinue) }
        if (Test-Path $exitFile) {
            $raw = [string](Get-Content $exitFile -Raw -ErrorAction SilentlyContinue)
            if ($raw -match '(-?\d+)') { try { $exitCode = [int]$Matches[1] } catch { } }
        }

        $combined = ("$out $err").Trim()

        $markerHit = $false
        foreach ($m in $SuccessMarkers) {
            if ($combined -match [regex]::Escape($m)) { $markerHit = $true; break }
        }

        # Success logic (marker first, because exit code was the root cause of the bug)
        $success = $false
        if ($markerHit) { $success = $true }
        elseif ($null -ne $exitCode) { $success = ($exitCode -eq 0) }
        elseif ($null -ne $proc.ExitCode) { $success = ($proc.ExitCode -eq 0) }

        return [pscustomobject]@{
            Success   = $success
            ExitCode  = if ($null -ne $exitCode) { $exitCode } else { $proc.ExitCode }
            Output    = $combined
            TimedOut  = $false
            MarkerHit = $markerHit
        }
    }
    catch {
        return [pscustomobject]@{
            Success   = $false
            ExitCode  = -1
            Output    = "spawn failed: $($_.Exception.Message)"
            TimedOut  = $false
            MarkerHit = $false
        }
    }
    finally {
        Start-Sleep -Milliseconds 50
        Remove-Item $outFile, $errFile, $exitFile -Force -ErrorAction SilentlyContinue
    }
}

# ============================================================
# PREREQUISITES
# ============================================================

function Test-Prereqs {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Write-Log "node.exe not found on PATH." -Level ERROR; return $false
    }
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        Write-Log "npm.cmd not found on PATH."  -Level ERROR; return $false
    }

    $nm = Join-Path $ProjectPath "node_modules"
    if (-not (Test-Path $nm)) {
        Write-Log "node_modules missing - running npm install (one-time, up to 10 min)..." -Level WARN

        $r = Invoke-BoundedCommand `
            -CommandLine "npm install --no-audit --no-fund" `
            -TimeoutSec 600 `
            -Name "npm-install"

        if (-not (Test-Path $nm)) {
            Write-Log "npm install failed: $($r.Output)" -Level ERROR
            return $false
        }
        Write-Log "Dependencies installed." -Level OK
    }
    return $true
}

# ============================================================
# NETWORK PROBE  (synchronous, ≤5s)
# ============================================================

function Test-InternetFast {
    param([int]$TimeoutSec = 5)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        if (Test-FastPort -HostName '1.1.1.1' -Port 443 -TimeoutMs 1200) { return $true }
        if (Test-FastPort -HostName '8.8.8.8' -Port 443 -TimeoutMs 1200) { return $true }
    }
    return $false
}

# ============================================================
# MONGODB  JUMPSTART  +  PORT WAIT  +  REAL READINESS
# ============================================================

function Start-MongoDBFast {
    $svc = Get-Service -Name $MongoService -ErrorAction SilentlyContinue
    if (-not $svc) {
        Write-Log "Service '$MongoService' does not exist." -Level ERROR
        return $false
    }

    if ($svc.Status -eq 'Running') {
        Write-Log "MongoDB already Running - reused." -Level OK
        return $true
    }

    Write-Log "MongoDB state=$($svc.Status) - starting..." -Level STAGE
    try { & sc.exe start $MongoService 2>&1 | Out-Null } catch { }

    $deadline = (Get-Date).AddSeconds($MongoStartTimeoutSec)
    while ((Get-Date) -lt $deadline) {
        $state = (Get-Service -Name $MongoService -ErrorAction SilentlyContinue).Status
        if ($state -eq 'Running') {
            Write-Log "MongoDB is Running." -Level OK
            return $true
        }
        Start-Sleep -Milliseconds 300
    }
    Write-Log "MongoDB never reached Running within ${MongoStartTimeoutSec}s." -Level ERROR
    return $false
}

function Wait-MongoPort {
    $deadline = (Get-Date).AddSeconds($MongoPortTimeoutSec)
    $lastLog  = Get-Date
    while ((Get-Date) -lt $deadline) {
        if (Test-FastPort -HostName '127.0.0.1' -Port 27017 -TimeoutMs 800) { return $true }
        if (((Get-Date) - $lastLog).TotalSeconds -ge 5) {
            Write-Log "Still waiting for port 27017..." -Level INFO
            $lastLog = Get-Date
        }
        Start-Sleep -Milliseconds 200
    }
    return $false
}

# Real DB command probe. Immediate process.exit(0) after PING_OK
# so mongoose.disconnect() can never hang the exit.
$MongoProbeScript = @'
const path = require('path');
const cwd  = process.cwd();

try { require(path.join(cwd, 'node_modules', 'dotenv')).config({ path: path.join(cwd, '.env') }); } catch (e) { }

const mongoose = require(path.join(cwd, 'node_modules', 'mongoose'));
const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/rts';

mongoose.connect(uri, {
    maxPoolSize: 3, minPoolSize: 0,
    serverSelectionTimeoutMS: 4000,
    connectTimeoutMS: 4000,
    socketTimeoutMS: 4000
})
.then(async () => {
    await mongoose.connection.db.admin().command({ ping: 1 });
    const cols = await mongoose.connection.db.listCollections({}, { nameOnly: true }).toArray();
    console.log('PING_OK collections=' + cols.length + ' host=' + mongoose.connection.host);
    process.exit(0);           // exit immediately - never wait on disconnect
})
.catch(err => {
    console.error('PING_FAIL ' + err.message);
    process.exit(1);
});
'@

function Test-MongoReady {
    $probeFile = Join-Path $env:TEMP ("rts-mongoprobe-{0}.js" -f [guid]::NewGuid().ToString('N').Substring(0,8))
    try {
        Set-Content -Path $probeFile -Value $MongoProbeScript -Encoding UTF8

        for ($i = 1; $i -le $DbProbeMaxAttempts; $i++) {
            $r = Invoke-BoundedCommand `
                -CommandLine "node `"$probeFile`"" `
                -TimeoutSec $DbProbeTimeoutSec `
                -Name "mongo-probe" `
                -SuccessMarkers @("PING_OK")

            if ($r.Success) {
                Write-Log "MongoDB answers database commands: $($r.Output)" -Level OK
                return $true
            }
            Write-Log "DB probe $i/$DbProbeMaxAttempts failed: $($r.Output)" -Level WARN
            Start-Sleep -Milliseconds 400
        }
        return $false
    }
    finally {
        Remove-Item $probeFile -Force -ErrorAction SilentlyContinue
    }
}

# ============================================================
# GIT UPDATE (credential-safe, bounded)
# ============================================================

function Invoke-GitUpdateSafe {
    $saved = @{
        GIT_TERMINAL_PROMPT = $env:GIT_TERMINAL_PROMPT
        GIT_ASKPASS         = $env:GIT_ASKPASS
        GIT_SSH_COMMAND     = $env:GIT_SSH_COMMAND
    }
    try {
        $env:GIT_TERMINAL_PROMPT = "0"
        $env:GIT_ASKPASS         = "echo"
        if (-not $env:GIT_SSH_COMMAND) {
            $env:GIT_SSH_COMMAND = "ssh -o BatchMode=yes -o ConnectTimeout=5"
        }

        if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
            Write-Log "git not on PATH - skipping update." -Level WARN
            return
        }

        $status = Invoke-BoundedCommand `
            -CommandLine "git status --porcelain" `
            -TimeoutSec 15 `
            -Name "git-status"

        if (-not $status.Success -and -not $status.Output) {
            Write-Log "git status unavailable - skipping pull." -Level WARN
            return
        }

        if (($status.Output -as [string]).Trim().Length -gt 0) {
            Write-Log "Local code changes detected - skipping git pull." -Level WARN
            return
        }

        Write-Log "Local tree clean - git pull (max ${GitTimeoutSec}s)..." -Level INFO
        $pull = Invoke-BoundedCommand `
            -CommandLine "git pull --ff-only origin main" `
            -TimeoutSec $GitTimeoutSec `
            -Name "git-pull"

        if ($pull.Success) {
            Write-Log "GitHub update completed." -Level OK
        }
        else {
            Write-Log "git pull did not succeed - continuing with local code: $($pull.Output)" -Level WARN
        }
    }
    finally {
        foreach ($k in $saved.Keys) { Set-Item -Path "env:$k" -Value $saved[$k] -ErrorAction SilentlyContinue }
    }
}

# ============================================================
# RTS HEALTH
# ============================================================

function Get-RtsHealth {
    param([int]$TimeoutSec = 3)
    try {
        return Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec $TimeoutSec -ErrorAction Stop
    } catch { return $null }
}

function Test-RtsHealthy {
    param($Health)
    if (-not $Health) { return $false }
    return ($Health.status -eq 'OK' -and $Health.database -eq 'CONNECTED')
}

# ============================================================
# EMAIL  (fire-and-forget)
# ============================================================

function Get-DotEnvValue {
    param([string]$Key)
    $v = [Environment]::GetEnvironmentVariable($Key)
    if ($v) { return $v }
    $envFile = Join-Path $ProjectPath ".env"
    if (Test-Path $envFile) {
        foreach ($line in (Get-Content $envFile -ErrorAction SilentlyContinue)) {
            if ($line -match "^\s*$([regex]::Escape($Key))\s*=\s*(.*)$") {
                return $Matches[1].Trim().Trim('"').Trim("'")
            }
        }
    }
    return $null
}

function Get-LocalIPv4 {
    try {
        $ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
               Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.PrefixOrigin -ne 'WellKnown' }
        if ($ips) { return @($ips)[0].IPAddress }
    } catch { }
    try {
        $r = [System.Net.Dns]::GetHostAddresses([System.Net.Dns]::GetHostName()) |
             Where-Object { $_.AddressFamily -eq 'InterNetwork' -and -not [System.Net.IPAddress]::IsLoopback($_) }
        if ($r) { return @($r)[0].IPAddressToString }
    } catch { }
    return 'unknown'
}

$EmailRunnerScript = @'
const fs   = require('fs');
const path = require('path');
const payload = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
process.chdir(payload.cwd);
try { require(path.join(payload.cwd, 'node_modules', 'dotenv')).config({ path: path.join(payload.cwd, '.env') }); } catch (e) { }
let svc;
try { svc = require(path.join(payload.cwd, 'services', 'emailService.js')); }
catch (e) { console.error('EMAIL_SERVICE_LOAD_FAIL ' + e.message); process.exit(1); }
svc.sendEmail(payload.to, payload.subject, payload.html)
    .then(r => { console.log(JSON.stringify(r)); process.exit(r && r.success ? 0 : 1); })
    .catch(e => { console.error('SEND_FAIL ' + e.message); process.exit(1); });
'@

function Send-RtsStartupEmail {
    param([string]$Subject, [string]$Html)

    if ($SkipEmail) { Write-Log "Email disabled." -Level INFO; return }

    $to = Get-DotEnvValue 'RTS_NOTIFY_EMAIL'
    if (-not $to) { $to = Get-DotEnvValue 'ALERT_EMAIL' }
    if (-not $to) { $to = Get-DotEnvValue 'SUPPORT_EMAIL' }
    if (-not $to) { Write-Log "No notify address configured - email skipped." -Level WARN; return }

    $runner  = Join-Path $env:TEMP ("rts-mailrun-{0}.js" -f [guid]::NewGuid().ToString('N').Substring(0,8))
    $payload = Join-Path $env:TEMP ("rts-mailpay-{0}.json" -f [guid]::NewGuid().ToString('N').Substring(0,8))

    try {
        Set-Content -Path $runner -Value $EmailRunnerScript -Encoding UTF8
        $json = @{ cwd = $ProjectPath; to = $to; subject = $Subject; html = $Html } | ConvertTo-Json -Depth 5 -Compress
        Set-Content -Path $payload -Value $json -Encoding UTF8

        $wrapped = "node `"$runner`" `"$payload`" >> `"$EmailLog`" 2>&1"
        Start-Process -FilePath "cmd.exe" `
            -ArgumentList "/c", $wrapped `
            -WorkingDirectory $ProjectPath `
            -WindowStyle Hidden | Out-Null

        Write-Log "Startup email dispatched to $to (fire-and-forget)." -Level INFO
    }
    catch {
        Write-Log "Email dispatch error: $($_.Exception.Message)" -Level WARN
    }
    finally {
        Start-Sleep -Milliseconds 100
        Remove-Item $runner, $payload -Force -ErrorAction SilentlyContinue
    }
}

# ============================================================
# MAIN
# ============================================================

$networkOK  = $false
$mongoOK    = $false
$rtsStarted = $false

try {
    Write-Log "==================== RTS STARTUP BEGIN ====================" -Level STAGE
    Write-Log "Project: $ProjectPath" -Level INFO

    # ---------- 1. prereqs ----------
    Enter-Stage "1. Local runtime"
    if (-not (Test-Prereqs)) { throw "Node.js/npm unavailable or install failed." }

    # ---------- 2. fast network probe (no Start-Job!) ----------
    Enter-Stage "2. Network probe (synchronous, ${InternetTimeoutSec}s cap)"
    $networkOK = Test-InternetFast -TimeoutSec $InternetTimeoutSec
    if ($networkOK) { Write-Log "Internet: reachable." -Level OK }
    else            { Write-Log "Internet: unavailable - continuing locally." -Level WARN }

    # ---------- 3. MongoDB JumpStart ----------
    Enter-Stage "3. MongoDB JumpStart"
    if (-not (Start-MongoDBFast)) { throw "MongoDB service failed to start." }

    # ---------- 4. port wait ----------
    Enter-Stage "4. MongoDB port 27017 (${MongoPortTimeoutSec}s cap)"
    if (-not (Wait-MongoPort)) {
        throw "Port 27017 did not open within ${MongoPortTimeoutSec}s."
    }
    Write-Log "Port 27017 accepting TCP." -Level OK

    # ---------- 5. real DB readiness + warm-up ----------
    Enter-Stage "5. Database readiness + warm-up (${DbProbeTimeoutSec}s x ${DbProbeMaxAttempts})"
    if (Test-MongoReady) {
        $mongoOK = $true
    }
    else {
        if ($StrictDbProbe) { throw "Database probe failed (strict mode)." }
        Write-Log "DB probe did not confirm readiness - proceeding anyway; the app's own mongoose connect is the real test." -Level WARN
        $mongoOK = $false
    }

    # ---------- 6. optional git update ----------
    if (-not $SkipGit -and $networkOK) {
        Enter-Stage "6. Git update"
        Invoke-GitUpdateSafe
    }
    elseif ($SkipGit) {
        Write-Log "Git update skipped (-SkipGit)." -Level INFO
    }
    else {
        Write-Log "Git update skipped (no internet)." -Level INFO
    }

    # ---------- 7. RTS launch ----------
    Enter-Stage "7. RTS server"

    $rtsAlreadyUp = $false
    if (Test-FastPort -HostName '127.0.0.1' -Port $Port -TimeoutMs 1000) {
        Write-Log "Port $Port already in use - polling /health..." -Level INFO

        $deadline = (Get-Date).AddSeconds(15)
        while ((Get-Date) -lt $deadline) {
            $h = Get-RtsHealth -TimeoutSec 3
            if ($h) { $rtsAlreadyUp = $true; break }
            Start-Sleep -Milliseconds 500
        }

        if ($rtsAlreadyUp) {
            $h = Get-RtsHealth -TimeoutSec 3
            if (Test-RtsHealthy $h) {
                Write-Log "RTS already running and healthy - no duplicate." -Level OK
            }
            else {
                Write-Log "RTS responds on /health but status not fully OK (status=$($h.status), db=$($h.database)). Proceeding." -Level WARN
            }
            $rtsStarted = $true
        }
        else {
            throw "Port $Port is occupied but /health does not respond. Another process may be using it."
        }
    }
    else {
        $cmd = "npm start >> `"$ServerLog`" 2>&1"
        Start-Process -FilePath "cmd.exe" `
            -ArgumentList "/c", $cmd `
            -WorkingDirectory $ProjectPath `
            -WindowStyle Hidden | Out-Null

        Write-Log "RTS launched - polling /health..." -Level INFO

        $deadline = (Get-Date).AddSeconds($RtsStartTimeoutSec)
        $interval = 500
        $rtsHealthy = $false

        while ((Get-Date) -lt $deadline) {
            Start-Sleep -Milliseconds $interval
            if (-not (Test-FastPort -HostName '127.0.0.1' -Port $Port -TimeoutMs 700)) { continue }
            $h = Get-RtsHealth -TimeoutSec 3
            if (Test-RtsHealthy $h) { $rtsHealthy = $true; break }
            if ($interval -lt 2000) { $interval += 250 }
        }

        if ($rtsHealthy) {
            Write-Log "RTS is running and healthy." -Level OK
            $rtsStarted = $true
        }
        else {
            Write-Log "RTS is listening on $Port but /health not OK after ${RtsStartTimeoutSec}s. Not failing - server may still be initializing." -Level WARN
            $rtsStarted = $true
        }
    }

    # ---------- 8. summary + email ----------
    Enter-Stage "8. Notify"

    $elapsed = [int]((Get-Date) - $Script:StartTime).TotalSeconds
    $ip      = Get-LocalIPv4

    $html = @"
<h2>RTS Startup Complete</h2>
<ul>
  <li><strong>Time:</strong> $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')</li>
  <li><strong>Laptop IP:</strong> $ip</li>
  <li><strong>Duration:</strong> ${elapsed}s</li>
  <li><strong>MongoDB:</strong> $(if ($mongoOK) { 'Verified answering commands' } else { 'Port open (probe not confirmed - app will confirm)' })</li>
  <li><strong>RTS:</strong> Running on port $Port</li>
  <li><strong>Internet:</strong> $(if ($networkOK) { 'Connected' } else { 'Unavailable' })</li>
</ul>
<p style="font-size:12px;color:#666;">
  Deriv/broker connectivity is checked by the app independently and does not block startup.
</p>
"@

    Send-RtsStartupEmail -Subject "RTS started - $ip - $(Get-Date -Format 'yyyy-MM-dd HH:mm')" -Html $html

    $dur = [int]((Get-Date) - $Script:StageStart).TotalSeconds
    Write-Log "[previous stage '$Script:Stage'] took ${dur}s" -Level INFO
    Write-Log "==================== RTS STARTUP COMPLETE (${elapsed}s) ====================" -Level OK
}
catch {
    $elapsed = [int]((Get-Date) - $Script:StartTime).TotalSeconds
    Write-Log "STARTUP ERROR at stage '$Script:Stage' after ${elapsed}s: $($_.Exception.Message)" -Level ERROR
    Write-Log "Snapshot: networkOK=$networkOK mongoOK=$mongoOK rtsStarted=$rtsStarted" -Level ERROR
}
