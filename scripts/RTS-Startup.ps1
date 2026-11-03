#Requires -Version 5.1
<#
.SYNOPSIS
    RTS INTELLIGENT STARTUP ENGINE
    Fast, quiet and self-healing launcher for D:\RTS\SmartTRADE

.DESCRIPTION
    1. Windows boot detection / fast internet probe (bounded, non-blocking)
    2. MongoDB JumpStart  -> starts the DB immediately, in parallel with the network check
    3. Real database readiness verification (port + actual database command = warm-up)
    4. RTS server launch (never duplicated)
    5. Bounded health verification (HTTP + DB)
    6. Deriv / market connectivity is NOT a startup blocker (checked by the app itself)
    7. Asynchronous startup notification email (laptop IP + status)

.NOTES
    - No Test-NetConnection anywhere. All connection checks are raw TCP with a hard timeout.
    - No infinite loops. Every wait has a deadline and a bounded retry count.
    - If something fails, the exact stage and reason are written to logs\startup-<date>.log
#>

[CmdletBinding()]
param(
    [string]$ProjectPath       = "D:\RTS\SmartTRADE",
    [string]$MongoService      = "MongoDB",
    [int]$Port                 = 5000,
    [int]$InternetTimeoutSec   = 15,
    [int]$MongoStartTimeoutSec = 60,
    [int]$RtsStartTimeoutSec   = 120,
    [switch]$SkipGit,
    [switch]$SkipEmail,
    [switch]$SkipDependencyCheck
)

$ErrorActionPreference = "Stop"
$ProgressPreference    = "SilentlyContinue"

$Script:StartTime = Get-Date

# ============================================================
# PATHS + LOGGING
# ============================================================

$LogPath   = Join-Path $ProjectPath "logs"
$ServerLog = Join-Path $LogPath "rts-server.log"

if (!(Test-Path $LogPath)) {
    New-Item -ItemType Directory -Path $LogPath -Force | Out-Null
}

$LogFile = Join-Path $LogPath ("startup-{0}.log" -f (Get-Date -Format 'yyyy-MM-dd'))

function Write-Log {
    param(
        [string]$Message,
        [ValidateSet('INFO','OK','WARN','ERROR','STAGE')][string]$Level = 'INFO'
    )
    $elapsed = [int]((Get-Date) - $Script:StartTime).TotalSeconds
    $line = "{0} [{1,4}s] [{2,-5}] {3}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $elapsed, $Level, $Message

    try { Add-Content -Path $LogFile -Value $line -Encoding UTF8 -ErrorAction SilentlyContinue } catch { }

    switch ($Level) {
        'ERROR' { Write-Host $line -ForegroundColor Red }
        'WARN'  { Write-Host $line -ForegroundColor Yellow }
        'OK'    { Write-Host $line -ForegroundColor Green }
        'STAGE' { Write-Host $line -ForegroundColor Cyan }
        default { Write-Host $line }
    }
}

# ============================================================
# FAST CONNECTION PRIMITIVES  (replaces Test-NetConnection)
# ============================================================

function Test-FastPort {
    param(
        [string]$HostName,
        [int]$Port,
        [int]$TimeoutMs = 2000
    )

    $Client = New-Object System.Net.Sockets.TcpClient

    try {
        $Async = $Client.BeginConnect($HostName, $Port, $null, $null)

        if (!$Async.AsyncWaitHandle.WaitOne($TimeoutMs, $false)) {
            return $false
        }

        $Client.EndConnect($Async)
        return $true
    }
    catch {
        return $false
    }
    finally {
        $Client.Close()
    }
}

function Wait-Port {
    param(
        [string]$HostName,
        [int]$Port,
        [int]$TimeoutSec = 30,
        [int]$IntervalMs = 250
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSec)

    while ((Get-Date) -lt $deadline) {
        if (Test-FastPort -HostName $HostName -Port $Port -TimeoutMs 1500) {
            return $true
        }
        Start-Sleep -Milliseconds $IntervalMs
    }

    return $false
}

# ============================================================
# NODE HELPERS  (bounded execution, no hanging processes)
# ============================================================

function Invoke-NodeInline {
    param(
        [string]$Code,
        [int]$TimeoutSec = 20,
        [string]$Name = 'inline',
        [string]$WorkingDirectory = $ProjectPath
    )

    $result = [pscustomobject]@{
        Success  = $false
        ExitCode = -1
        Output   = ''
    }

    $tmp = Join-Path $env:TEMP ("rts-{0}-{1}.js" -f $Name, ([guid]::NewGuid().ToString('N').Substring(0, 8)))
    $out = "$tmp.out"
    $err = "$tmp.err"

    try {
        Set-Content -Path $tmp -Value $Code -Encoding UTF8

        $proc = Start-Process -FilePath "node" `
            -ArgumentList "`"$tmp`"" `
            -WorkingDirectory $WorkingDirectory `
            -WindowStyle Hidden `
            -PassThru `
            -RedirectStandardOutput $out `
            -RedirectStandardError $err

        if (-not $proc.WaitForExit($TimeoutSec * 1000)) {
            try { $proc.Kill() } catch { }
            $result.Output = "timeout after ${TimeoutSec}s"
            return $result
        }

        $stdout = ''
        $stderr = ''
        if (Test-Path $out) { $stdout = [string](Get-Content $out -Raw -ErrorAction SilentlyContinue) }
        if (Test-Path $err) { $stderr = [string](Get-Content $err -Raw -ErrorAction SilentlyContinue) }

        $result.ExitCode = $proc.ExitCode
        $result.Success  = ($proc.ExitCode -eq 0)
        $result.Output   = ("$stdout $stderr").Trim()
    }
    catch {
        $result.Output = $_.Exception.Message
    }
    finally {
        Remove-Item $tmp, $out, $err -Force -ErrorAction SilentlyContinue
    }

    return $result
}

function Test-NodeAvailable {
    $node = Get-Command node -ErrorAction SilentlyContinue
    $npm  = Get-Command npm  -ErrorAction SilentlyContinue
    if (-not $node) { Write-Log "node.exe not found on PATH." -Level ERROR; return $false }
    if (-not $npm)  { Write-Log "npm.cmd not found on PATH."  -Level ERROR; return $false }
    return $true
}

function Ensure-NodeModules {
    $nm = Join-Path $ProjectPath "node_modules"
    if (Test-Path $nm) { return $true }

    Write-Log "node_modules missing - running npm install (one time)..." -Level WARN

    $proc = Start-Process -FilePath "cmd.exe" `
        -ArgumentList "/c", "npm install --no-audit --no-fund >> `"$ServerLog`" 2>&1" `
        -WorkingDirectory $ProjectPath `
        -WindowStyle Hidden `
        -PassThru

    if (-not $proc.WaitForExit(600000)) {
        try { $proc.Kill() } catch { }
        Write-Log "npm install timed out after 600s." -Level ERROR
        return $false
    }

    if (Test-Path $nm) {
        Write-Log "Dependencies installed." -Level OK
        return $true
    }

    Write-Log "npm install did not create node_modules." -Level ERROR
    return $false
}

# ============================================================
# MONGODB  JUMPSTART  +  REAL READINESS / WARM-UP
# ============================================================

function Start-MongoDBJumpStart {
    $svc = Get-Service -Name $MongoService -ErrorAction SilentlyContinue

    if (-not $svc) {
        Write-Log "MongoDB service '$MongoService' does not exist on this machine." -Level ERROR
        return $false
    }

    if ($svc.Status -eq 'Running') {
        Write-Log "MongoDB already running - reused, not restarted." -Level OK
        return $true
    }

    Write-Log "MongoDB state: $($svc.Status). JumpStarting now..." -Level STAGE

    $deadline = (Get-Date).AddSeconds($MongoStartTimeoutSec)
    $attempt  = 0
    $running  = $false

    while ((Get-Date) -lt $deadline) {

        $attempt++

        try {
            if ($attempt -eq 1) {
                Start-Service -Name $MongoService -ErrorAction Stop
            }
            elseif ($attempt -le 3) {
                & sc.exe start $MongoService | Out-Null
            }
        }
        catch {
            Write-Log "Start attempt $attempt : $($_.Exception.Message)" -Level WARN
        }

        # Wait for the service to actually reach Running
        while ((Get-Date) -lt $deadline) {
            $state = (Get-Service -Name $MongoService -ErrorAction SilentlyContinue).Status
            if ($state -eq 'Running') { $running = $true; break }
            Start-Sleep -Milliseconds 400
        }

        if ($running) { break }
        Start-Sleep -Seconds 1
    }

    if ($running) {
        Write-Log "MongoDB service is Running." -Level OK
    }
    else {
        Write-Log "MongoDB service never reached Running state (${MongoStartTimeoutSec}s)." -Level ERROR
    }

    return $running
}

# Actual database command probe. This also warms up the connection pool.
$MongoProbeScript = @'
const path = require('path');
const cwd  = process.cwd();

try { require(path.join(cwd, 'node_modules', 'dotenv')).config({ path: path.join(cwd, '.env') }); } catch (e) { }

const mongoose = require(path.join(cwd, 'node_modules', 'mongoose'));
const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/rts';

mongoose.connect(uri, {
    maxPoolSize: 5,
    minPoolSize: 1,
    serverSelectionTimeoutMS: 8000,
    connectTimeoutMS: 8000,
    socketTimeoutMS: 15000
})
.then(async () => {
    await mongoose.connection.db.admin().command({ ping: 1 });
    const cols = await mongoose.connection.db.listCollections({}, { nameOnly: true }).toArray();
    console.log('PING_OK collections=' + cols.length + ' host=' + mongoose.connection.host);
    await mongoose.disconnect();
    process.exit(0);
})
.catch(err => {
    console.error('PING_FAIL ' + err.message);
    process.exit(1);
});
'@

function Test-MongoReady {
    for ($i = 1; $i -le 3; $i++) {
        $probe = Invoke-NodeInline -Code $MongoProbeScript -TimeoutSec 25 -Name "mongoprobe"

        if ($probe.Success) {
            Write-Log "MongoDB answered a real database command: $($probe.Output)" -Level OK
            return $true
        }

        Write-Log "Database probe attempt $i failed: $($probe.Output)" -Level WARN
        Start-Sleep -Milliseconds 800
    }

    return $false
}

# ============================================================
# RTS HEALTH
# ============================================================

function Get-RtsHealth {
    param([int]$TimeoutSec = 3)

    try {
        return Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec $TimeoutSec -ErrorAction Stop
    }
    catch {
        return $null
    }
}

function Test-RtsHealthy {
    param($Health)

    if (-not $Health) { return $false }
    return ($Health.status -eq 'OK' -and $Health.database -eq 'CONNECTED')
}

# ============================================================
# EMAIL  (asynchronous, best-effort, never blocks startup)
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
               Where-Object {
                   $_.IPAddress -notlike '127.*' -and
                   $_.IPAddress -notlike '169.254.*' -and
                   $_.PrefixOrigin -ne 'WellKnown'
               }

        if ($ips) { return @($ips)[0].IPAddress }
    }
    catch { }

    try {
        $resolved = [System.Net.Dns]::GetHostAddresses([System.Net.Dns]::GetHostName()) |
                    Where-Object {
                        $_.AddressFamily -eq 'InterNetwork' -and
                        -not [System.Net.IPAddress]::IsLoopback($_)
                    }

        if ($resolved) { return @($resolved)[0].IPAddressToString }
    }
    catch { }

    return 'unknown'
}

$EmailRunnerScript = @'
const fs   = require('fs');
const path = require('path');

const payloadPath = process.argv[2];
const payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));

process.chdir(payload.cwd);

try {
    require(path.join(payload.cwd, 'node_modules', 'dotenv')).config({ path: path.join(payload.cwd, '.env') });
} catch (e) { }

let svc;
try {
    svc = require(path.join(payload.cwd, 'services', 'emailService.js'));
} catch (e) {
    console.error('EMAIL_SERVICE_LOAD_FAIL ' + e.message);
    process.exit(1);
}

svc.sendEmail(payload.to, payload.subject, payload.html)
    .then(r => {
        console.log(JSON.stringify(r));
        process.exit(r && r.success ? 0 : 1);
    })
    .catch(e => {
        console.error('SEND_FAIL ' + e.message);
        process.exit(1);
    });
'@

function Send-RtsStartupEmail {
    param(
        [string]$Subject,
        [string]$Html
    )

    if ($SkipEmail) { Write-Log "Email disabled by switch." -Level INFO; return }

    $to = Get-DotEnvValue 'RTS_NOTIFY_EMAIL'
    if (-not $to) { $to = Get-DotEnvValue 'ALERT_EMAIL' }
    if (-not $to) { $to = Get-DotEnvValue 'SUPPORT_EMAIL' }

    if (-not $to) {
        Write-Log "No notification address configured (RTS_NOTIFY_EMAIL / ALERT_EMAIL / SUPPORT_EMAIL). Email skipped." -Level WARN
        return
    }

    if (-not (Test-Path (Join-Path $ProjectPath "node_modules\mongoose"))) {
        Write-Log "Dependencies not ready - email skipped." -Level WARN
        return
    }

    $runnerFile  = Join-Path $env:TEMP ("rts-email-runner-{0}.js" -f ([guid]::NewGuid().ToString('N').Substring(0, 8)))
    $payloadFile = Join-Path $env:TEMP ("rts-email-payload-{0}.json" -f ([guid]::NewGuid().ToString('N').Substring(0, 8)))
    $outFile     = "$runnerFile.out"
    $errFile     = "$runnerFile.err"

    try {
        Set-Content -Path $runnerFile -Value $EmailRunnerScript -Encoding UTF8

        $payload = @{
            cwd     = $ProjectPath
            to      = $to
            subject = $Subject
            html    = $Html
        } | ConvertTo-Json -Depth 5 -Compress

        Set-Content -Path $payloadFile -Value $payload -Encoding UTF8

        $proc = Start-Process -FilePath "node" `
            -ArgumentList "`"$runnerFile`" `"$payloadFile`"" `
            -WorkingDirectory $ProjectPath `
            -WindowStyle Hidden `
            -PassThru `
            -RedirectStandardOutput $outFile `
            -RedirectStandardError $errFile

        # Fire and forget: give it a short window, then let it finish in the background.
        if ($proc.WaitForExit(10000)) {
            $stdout = ''
            $stderr = ''
            if (Test-Path $outFile) { $stdout = [string](Get-Content $outFile -Raw -ErrorAction SilentlyContinue) }
            if (Test-Path $errFile) { $stderr = [string](Get-Content $errFile -Raw -ErrorAction SilentlyContinue) }

            if ($proc.ExitCode -eq 0) {
                Write-Log "Startup email sent to $to." -Level OK
            }
            else {
                Write-Log "Startup email failed: $((("$stdout $stderr").Trim()))" -Level WARN
            }
        }
        else {
            Write-Log "Startup email is still sending in the background." -Level INFO
        }
    }
    catch {
        Write-Log "Startup email error: $($_.Exception.Message)" -Level WARN
    }
    finally {
        Start-Sleep -Milliseconds 200
        Remove-Item $runnerFile, $payloadFile, $outFile, $errFile -Force -ErrorAction SilentlyContinue
    }
}

# ============================================================
# BACKGROUND NETWORK + GIT TASK  (runs in parallel with MongoDB JumpStart)
# ============================================================

$NetJob = $null

function Start-NetworkAndUpdateJob {
    param(
        [int]$InternetTimeoutSec,
        [bool]$SkipGit
    )

    return Start-Job -Name "RTS-NetGit" -ScriptBlock {
        param($ProjectPath, $InternetTimeoutSec, $SkipGit)

        function Test-FastPort($HostName, $Port, $TimeoutMs = 2000) {
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

        $result = [pscustomobject]@{
            Internet = $false
            Git      = 'skipped'
            Message  = ''
        }

        $deadline = (Get-Date).AddSeconds($InternetTimeoutSec)

        while ((Get-Date) -lt $deadline) {
            if ((Test-FastPort '1.1.1.1' 443 1500) -or (Test-FastPort '8.8.8.8' 443 1500)) {
                $result.Internet = $true
                break
            }
            Start-Sleep -Milliseconds 500
        }

        if (-not $result.Internet) {
            $result.Message = 'Internet unavailable - local startup continued'
            return $result
        }

        if ($SkipGit) {
            $result.Message = 'Git update disabled'
            return $result
        }

        if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
            $result.Message = 'git not installed'
            return $result
        }

        Set-Location $ProjectPath

        $changes = @(git status --porcelain 2>$null)

        if ($LASTEXITCODE -ne 0) {
            $result.Message = 'Could not read git status'
            return $result
        }

        if ($changes.Count -gt 0) {
            $result.Git     = 'skipped'
            $result.Message = 'Local code changes detected - pull skipped to protect your work'
            return $result
        }

        git pull --ff-only origin main 2>&1 | Out-Null

        if ($LASTEXITCODE -eq 0) {
            $result.Git     = 'updated'
            $result.Message = 'GitHub update completed'
        }
        else {
            $result.Git     = 'failed'
            $result.Message = 'git pull failed - using local code'
        }

        return $result
    } -ArgumentList $ProjectPath, $InternetTimeoutSec, $SkipGit
}

# ============================================================
# MAIN
# ============================================================

$networkResult = $null
$mongoReady    = $false
$rtsStarted    = $false

try {
    Write-Log "==================== RTS STARTUP BEGIN ====================" -Level STAGE

    # ---------- STAGE 0 : prerequisites (local, instant) ----------
    Write-Log "Stage 0 - Checking local runtime..." -Level STAGE

    if (-not (Test-NodeAvailable)) {
        throw "Node.js / npm is not available on PATH."
    }

    if (-not $SkipDependencyCheck) {
        if (-not (Ensure-NodeModules)) {
            throw "Node dependencies are not installed and npm install failed."
        }
    }

    # ---------- STAGE 1 : fire the network/git task in the BACKGROUND ----------
    Write-Log "Stage 1 - Network probe + code update started in background." -Level STAGE
    $NetJob = Start-NetworkAndUpdateJob -InternetTimeoutSec $InternetTimeoutSec -SkipGit ([bool]$SkipGit)

    # ---------- STAGE 2 : MongoDB JUMPSTART (parallel with network) ----------
    Write-Log "Stage 2 - MongoDB JumpStart..." -Level STAGE

    if (-not (Start-MongoDBJumpStart)) {
        throw "MongoDB could not be started. RTS will not be launched against a dead database."
    }

    # ---------- STAGE 3 : real readiness + warm-up ----------
    Write-Log "Stage 3 - Verifying MongoDB readiness (port + database command)..." -Level STAGE

    if (-not (Wait-Port -HostName '127.0.0.1' -Port 27017 -TimeoutSec $MongoStartTimeoutSec -IntervalMs 250)) {
        throw "MongoDB did not open port 27017 within ${MongoStartTimeoutSec}s."
    }
    Write-Log "Port 27017 is accepting TCP connections." -Level OK

    if (-not (Test-MongoReady)) {
        throw "MongoDB is listening on 27017 but does not answer database commands. Check the MongoDB log."
    }

    $mongoReady = $true

    # ---------- STAGE 4 : collect the background network/git result ----------
    Write-Log "Stage 4 - Collecting network / update result..." -Level STAGE

    $jobDone = Wait-Job -Job $NetJob -Timeout 60

    if ($jobDone) {
        $networkResult = Receive-Job -Job $NetJob -ErrorAction SilentlyContinue
    }
    else {
        Write-Log "Network/update task exceeded 60s - stopping it and continuing with local code." -Level WARN
        Stop-Job -Job $NetJob -ErrorAction SilentlyContinue
    }

    if ($networkResult) {
        if ($networkResult.Internet) {
            Write-Log "Internet: connected. Update: $($networkResult.Message)" -Level INFO
        }
        else {
            Write-Log "Internet: unavailable. $($networkResult.Message)" -Level WARN
        }
    }
    else {
        Write-Log "No network result returned - continuing with local code." -Level WARN
    }

    Remove-Job -Job $NetJob -Force -ErrorAction SilentlyContinue
    $NetJob = $null

    # ---------- STAGE 5 : is RTS already running? ----------
    Write-Log "Stage 5 - Checking whether RTS is already running on port $Port..." -Level STAGE

    if (Test-FastPort -HostName '127.0.0.1' -Port $Port -TimeoutMs 1500) {

        $health = Get-RtsHealth -TimeoutSec 5

        if (Test-RtsHealthy $health) {
            Write-Log "RTS is already running and healthy. No duplicate server started." -Level OK
            $rtsStarted = $true
        }
        else {
            throw "Port $Port is occupied but RTS is not healthy (status=$($health.status), database=$($health.database)). Not starting a duplicate - inspect the existing process."
        }
    }
    else {

        # ---------- STAGE 6 : launch RTS (once) ----------
        Write-Log "Stage 6 - Starting RTS Node server..." -Level STAGE

        $Command = "npm start >> `"$ServerLog`" 2>&1"

        Start-Process `
            -FilePath "cmd.exe" `
            -ArgumentList "/c", $Command `
            -WorkingDirectory $ProjectPath `
            -WindowStyle Hidden | Out-Null

        # ---------- STAGE 7 : bounded health polling ----------
        Write-Log "Stage 7 - Waiting for RTS health check..." -Level STAGE

        $rtsReady  = $false
        $deadline  = (Get-Date).AddSeconds($RtsStartTimeoutSec)

        while ((Get-Date) -lt $deadline) {

            Start-Sleep -Milliseconds 750

            if (-not (Test-FastPort -HostName '127.0.0.1' -Port $Port -TimeoutMs 800)) {
                continue
            }

            $health = Get-RtsHealth -TimeoutSec 3

            if (Test-RtsHealthy $health) {
                $rtsReady = $true
                break
            }
        }

        if (-not $rtsReady) {
            throw "RTS did not pass its health check within ${RtsStartTimeoutSec}s. See logs\rts-server.log."
        }

        Write-Log "RTS is running and healthy." -Level OK
        $rtsStarted = $true
    }

    # ---------- STAGE 8 : summary + notification ----------
    $elapsed = [int]((Get-Date) - $Script:StartTime).TotalSeconds
    $ip      = Get-LocalIPv4

    Write-Log "Stage 8 - Startup completed in ${elapsed}s. Laptop IP: $ip" -Level STAGE

    $internetText = if ($networkResult -and $networkResult.Internet) { 'Connected' } else { 'Unavailable' }
    $updateText   = if ($networkResult) { $networkResult.Message } else { 'not checked' }

    $html = @"
<h2>RTS Startup Successful ✅</h2>
<ul>
    <li><strong>Time:</strong> $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')</li>
    <li><strong>Laptop IP:</strong> $ip</li>
    <li><strong>Startup duration:</strong> ${elapsed}s</li>
    <li><strong>MongoDB:</strong> Running and answering database commands</li>
    <li><strong>RTS:</strong> Healthy on port $Port</li>
    <li><strong>Internet:</strong> $internetText</li>
    <li><strong>Code update:</strong> $updateText</li>
</ul>
<p style="font-size:12px;color:#666;">
    Note: Deriv/broker connectivity and market status are checked independently by the platform
    and do not block dashboard startup.
</p>
"@

    Send-RtsStartupEmail -Subject "RTS started - $ip - $(Get-Date -Format 'yyyy-MM-dd HH:mm')" -Html $html

    Write-Log "==================== RTS STARTUP COMPLETE ====================" -Level OK
}
catch {
    Write-Log "STARTUP ERROR: $($_.Exception.Message)" -Level ERROR
    Write-Log "Stage snapshot -> MongoDB ready: $mongoReady | RTS started: $rtsStarted" -Level ERROR
}
finally {
    if ($NetJob) {
        Stop-Job -Job $NetJob -ErrorAction SilentlyContinue
        Remove-Job -Job $NetJob -Force -ErrorAction SilentlyContinue
    }

    $total = [int]((Get-Date) - $Script:StartTime).TotalSeconds
    Write-Log "Total script time: ${total}s" -Level INFO
}
