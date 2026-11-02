
# RTS AUTOMATIC STARTUP
# Project: D:\RTS\SmartTRADE

$ErrorActionPreference = "Stop"

$ProjectPath = "D:\RTS\SmartTRADE"
$LogPath = "$ProjectPath\logs"
$MongoService = "MongoDB"
$Port = 5000

if (!(Test-Path $LogPath)) {
    New-Item -ItemType Directory -Path $LogPath -Force | Out-Null
}

$LogFile = "$LogPath\startup-$(Get-Date -Format 'yyyy-MM-dd').log"

function Write-Log($Message) {
    $Line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') - $Message"
    Add-Content -Path $LogFile -Value $Line
    Write-Host $Line
}

try {
    Write-Log "========== RTS STARTUP BEGIN =========="

    # 1. Wait for internet
    Write-Log "Waiting for internet connection..."

    $InternetReady = $false

    for ($i = 0; $i -lt 36; $i++) {
        if (Test-NetConnection github.com -Port 443 -InformationLevel Quiet) {
            $InternetReady = $true
            break
        }
        Start-Sleep -Seconds 5
    }

    if (!$InternetReady) {
        Write-Log "WARNING: Internet unavailable. Skipping GitHub update."
    }
    else {
        Write-Log "Internet connection detected."

        # 2. Safely update from GitHub
        Set-Location $ProjectPath

        $Changes = git status --porcelain

        if ($LASTEXITCODE -ne 0) {
            Write-Log "WARNING: Could not check Git status. Skipping update."
        }
        elseif ($Changes) {
            Write-Log "WARNING: Local code changes detected. Skipping Git pull to protect your work."
        }
        else {
            Write-Log "Local code is clean. Checking GitHub updates."

            git pull --ff-only origin main

            if ($LASTEXITCODE -eq 0) {
                Write-Log "GitHub update completed."
            }
            else {
                Write-Log "WARNING: Git pull failed. Continuing with local code."
            }
        }
    }

    # 3. Start MongoDB
    Write-Log "Checking MongoDB service..."

    $Mongo = Get-Service -Name $MongoService

    if ($Mongo.Status -ne "Running") {
        Start-Service -Name $MongoService
    }

    $MongoReady = $false

    for ($i = 0; $i -lt 30; $i++) {
        if ((Get-Service -Name $MongoService).Status -eq "Running" -and
            (Test-NetConnection 127.0.0.1 -Port 27017 -InformationLevel Quiet)) {
            $MongoReady = $true
            break
        }
        Start-Sleep -Seconds 2
    }

    if (!$MongoReady) {
        throw "MongoDB did not become ready on port 27017."
    }

    Write-Log "MongoDB is ready."

    # 4. Check whether RTS is already running
    $ExistingServer = Test-NetConnection 127.0.0.1 -Port $Port -InformationLevel Quiet

    if ($ExistingServer) {
        try {
            $Health = Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 5

            if ($Health.status -eq "OK" -and $Health.database -eq "CONNECTED") {
                Write-Log "RTS is already healthy. No duplicate server started."
            }
            else {
                throw "Port 5000 is occupied but RTS is not healthy. Not starting a duplicate."
            }
        }
        catch {
            throw "Port 5000 is occupied, but RTS health check failed. Check the existing process."
        }
    }
    else {
        # 5. Start RTS
        Write-Log "Starting RTS Node server..."

        $ServerLog = "$LogPath\rts-server.log"
        $Command = "npm start >> `"$ServerLog`" 2>&1"

        Start-Process `
            -FilePath "cmd.exe" `
            -ArgumentList "/c", $Command `
            -WorkingDirectory $ProjectPath `
            -WindowStyle Hidden

        # 6. Wait for healthy RTS
        $RTSReady = $false

        for ($i = 0; $i -lt 45; $i++) {
            Start-Sleep -Seconds 2

            try {
                $Health = Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 3

                if ($Health.status -eq "OK" -and $Health.database -eq "CONNECTED") {
                    $RTSReady = $true
                    break
                }
            }
            catch {
                # RTS is still starting.
            }
        }

        if (!$RTSReady) {
            throw "RTS did not pass its health check. Check logs\rts-server.log."
        }

        Write-Log "RTS is running and healthy."
    }

    Write-Log "RTS startup completed successfully."
}
catch {
    Write-Log "STARTUP ERROR: $($_.Exception.Message)"
}
