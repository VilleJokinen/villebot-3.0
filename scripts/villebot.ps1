# Starts the bot, stops it, or toggles starting it at logon. Used by start.cmd and stop.cmd in the
# project root. The public panel link is a Cloudflare Tunnel running as its own Windows service
# (`cloudflared service install <token>`); this script only checks that it's up.
#
#   villebot.ps1 tray            bot in the background, with a taskbar tray icon to control it
#   villebot.ps1 start           bot in the current console, for watching the output live
#   villebot.ps1 stop            stops the bot (the tunnel keeps running)
#   villebot.ps1 autostart-on    run the tray at every Windows logon
#   villebot.ps1 autostart-off   undo autostart-on
param(
    [ValidateSet('tray', 'start', 'stop', 'autostart-on', 'autostart-off')]
    [string]$Action = 'tray'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $root 'villebot.pid'
$logFile = Join-Path $root 'villebot.log'
$shortcut = Join-Path ([Environment]::GetFolderPath('Startup')) 'VilleBot.lnk'

function Get-EnvValue([string]$name) {
    $envFile = Join-Path $root '.env'
    if (Test-Path $envFile) {
        foreach ($line in Get-Content $envFile) {
            if ($line -match "^\s*$name\s*=\s*(.*?)\s*$") { return $Matches[1].Trim('"', "'") }
        }
    }
    return $null
}

function Get-PanelPort {
    $port = Get-EnvValue 'PANEL_PORT'
    if ($port -match '^\d+$') { return [int]$port }
    return 3000
}

function Get-Listener([int]$port) {
    Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
}

# The PowerShell process that launched the bot, if it is still alive. The process name check
# keeps a stale pid file from pointing at an unrelated process that reused the id.
function Get-Launcher {
    if (-not (Test-Path $pidFile)) { return $null }
    $id = (Get-Content $pidFile -Raw).Trim()
    $p = Get-Process -Id $id -ErrorAction SilentlyContinue
    if ($p -and $p.ProcessName -eq 'powershell') { return $p }
    return $null
}

# Returns why the panel link is down, or $null when the Cloudflare Tunnel service is running.
function Get-TunnelProblem {
    $service = Get-Service -Name cloudflared -ErrorAction SilentlyContinue
    if (-not $service) { return 'Cloudflare Tunnel is not installed as a service. See "Sharing it with friends" in the README.' }
    if ($service.Status -eq 'Running') { return $null }
    return "Cloudflare Tunnel is $($service.Status.ToString().ToLower()). Start the Cloudflared service (services.msc); the panel link is down until then."
}

function Assert-NotRunning {
    $port = Get-PanelPort
    if (Get-Listener $port) {
        $message = "Something is already listening on port $port; the bot is probably running. Use stop.cmd first."
        if ($Action -eq 'tray') {
            Add-Type -AssemblyName System.Windows.Forms
            [System.Windows.Forms.MessageBox]::Show($message, 'VilleBot') | Out-Null
        } else {
            Write-Host $message
        }
        exit 1
    }
}

function Start-Console {
    Assert-NotRunning
    Set-Location $root
    Set-Content -Path $pidFile -Value $PID
    try {
        $problem = Get-TunnelProblem
        if ($problem) { Write-Warning "$problem Starting the bot anyway." }
        npm.cmd start
    } finally {
        Remove-Item $pidFile -ErrorAction SilentlyContinue
    }
}

function Stop-Bot {
    $launcher = Get-Launcher
    if ($launcher) {
        taskkill /PID $launcher.Id /T /F | Out-Null
        Remove-Item $pidFile -ErrorAction SilentlyContinue
        Write-Host 'Bot stopped.'
        return
    }
    Remove-Item $pidFile -ErrorAction SilentlyContinue

    # Started some other way (e.g. npm run dev in a terminal): stop whatever owns the panel port if it's node.
    $listener = Get-Listener (Get-PanelPort)
    $owner = if ($listener) { Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" }
    if (-not $owner -or $owner.Name -ne 'node.exe') {
        Write-Host 'Bot is not running.'
        return
    }
    # Climb to the outermost npm/tsx process (npm > cmd > tsx > node) so none of the wrappers is left behind,
    # stopping before the terminal the user started it from.
    $top = $owner
    while ($true) {
        $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($top.ParentProcessId)"
        if (-not $parent -or $parent.Name -notin 'node.exe', 'cmd.exe' -or $parent.CommandLine -notmatch 'npm|tsx') { break }
        $top = $parent
    }
    taskkill /PID $top.ProcessId /T /F | Out-Null
    Write-Host 'Bot stopped.'
}

# A job object that kills every process in it once the tray process is gone, however it ends (Exit,
# Task Manager, a crash), so the bot can't keep playing without its tray icon.
$killOnCloseJob = @'
using System;
using System.Runtime.InteropServices;

public static class KillOnCloseJob {
    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimits {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimits {
        public BasicLimits Basic;
        public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    // Never closed on purpose: Windows closes it when this process exits, which kills the job.
    static IntPtr job;

    public static void Add(IntPtr process) {
        if (job == IntPtr.Zero) {
            job = CreateJobObject(IntPtr.Zero, null);
            var info = new ExtendedLimits();
            info.Basic.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            if (!SetInformationJobObject(job, 9, ref info, (uint)Marshal.SizeOf(typeof(ExtendedLimits)))) {
                throw new System.ComponentModel.Win32Exception();
            }
        }
        if (!AssignProcessToJobObject(job, process)) throw new System.ComponentModel.Win32Exception();
    }
}
'@

function Start-Tray {
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    Add-Type -TypeDefinition $killOnCloseJob

    $mutex = New-Object System.Threading.Mutex($false, 'Local\VilleBotTray')
    if (-not $mutex.WaitOne(0)) { exit 0 } # the tray is already running
    Assert-NotRunning

    Set-Location $root
    Set-Content -Path $pidFile -Value $PID

    $port = Get-PanelPort
    $panelUrl = Get-EnvValue 'PANEL_URL'
    if (-not $panelUrl) { $panelUrl = "http://127.0.0.1:$port/" }

    function New-Icon([System.Drawing.Color]$color) {
        $bmp = New-Object System.Drawing.Bitmap 32, 32
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.SmoothingMode = 'AntiAlias'
        $g.TextRenderingHint = 'AntiAliasGridFit'
        $g.FillEllipse((New-Object System.Drawing.SolidBrush $color), 1, 1, 30, 30)
        $font = New-Object System.Drawing.Font 'Segoe UI', 18, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
        $format = New-Object System.Drawing.StringFormat
        $format.Alignment = 'Center'
        $format.LineAlignment = 'Center'
        $g.DrawString('V', $font, [System.Drawing.Brushes]::White, (New-Object System.Drawing.RectangleF 0, 1, 32, 32), $format)
        $g.Dispose()
        [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
    }
    $runningIcon = New-Icon ([System.Drawing.Color]::FromArgb(88, 101, 242))
    $stoppedIcon = New-Icon ([System.Drawing.Color]::FromArgb(128, 128, 128))

    $script:bot = $null
    $script:stopping = $false
    $script:tunnelProblem = $null
    $script:healthProblem = $null
    $script:lastHealthAlert = [DateTime]::MinValue
    $script:logPos = 0
    $script:logTail = ''

    $tray = New-Object System.Windows.Forms.NotifyIcon
    $menu = New-Object System.Windows.Forms.ContextMenuStrip
    $status = $menu.Items.Add('')
    $status.Enabled = $false
    [void]$menu.Items.Add('-')
    $openPanel = $menu.Items.Add('Open panel')
    $openLog = $menu.Items.Add('Open log')
    [void]$menu.Items.Add('-')
    $startItem = $menu.Items.Add('Start bot')
    $stopItem = $menu.Items.Add('Stop bot')
    [void]$menu.Items.Add('-')
    $exitItem = $menu.Items.Add('Exit')
    $tray.ContextMenuStrip = $menu

    function Update-State {
        $running = $script:bot -and -not $script:bot.HasExited
        $tray.Icon = if ($running) { $runningIcon } else { $stoppedIcon }
        $tray.Text = if ($running) { 'VilleBot: running' } else { 'VilleBot: stopped' }
        $notes = @()
        if ($running -and $script:healthProblem) { $notes += 'audio lagging' }
        if ($script:tunnelProblem) { $notes += 'panel link down' }
        $status.Text = if ($notes) { "$($tray.Text) ($($notes -join ', '))" } else { $tray.Text }
        $startItem.Text = if ($running) { 'Restart bot' } else { 'Start bot' }
        $stopItem.Enabled = $running
    }

    function Start-BotProcess {
        Add-Content -Path $logFile -Value "`r`n=== $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') starting ==="
        $script:logPos = (Get-Item $logFile).Length
        $script:logTail = ''
        $script:healthProblem = $null
        # cmd handles the redirection; this console is hidden, so the children get no window either.
        $psi = New-Object System.Diagnostics.ProcessStartInfo 'cmd.exe', '/c npm start >> villebot.log 2>&1'
        $psi.WorkingDirectory = $root
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $script:stopping = $false
        $script:bot = [System.Diagnostics.Process]::Start($psi)
        # npm and node are started after this by cmd, and inherit the job.
        [KillOnCloseJob]::Add($script:bot.Handle)
        Update-State
    }

    function Stop-BotProcess {
        if ($script:bot -and -not $script:bot.HasExited) {
            $script:stopping = $true
            taskkill /PID $script:bot.Id /T /F | Out-Null
            $script:bot.WaitForExit(5000) | Out-Null
        }
        Update-State
    }

    $openPanel.add_Click({ Start-Process $panelUrl })
    $tray.add_DoubleClick({ Start-Process $panelUrl })
    $openLog.add_Click({ if (Test-Path $logFile) { Start-Process notepad.exe $logFile } })
    $startItem.add_Click({ Stop-BotProcess; Start-BotProcess })
    $stopItem.add_Click({ Stop-BotProcess })
    $exitItem.add_Click({
        Stop-BotProcess
        $tray.Visible = $false
        [System.Windows.Forms.Application]::Exit()
    })

    # Process.Exited fires on a thread PowerShell can't run script on, so poll from the UI thread instead.
    # Alerts once each time the tunnel goes from running to not running (and at startup if it already is).
    function Test-Tunnel {
        $problem = Get-TunnelProblem
        if ($problem -and -not $script:tunnelProblem) {
            $tray.ShowBalloonTip(10000, 'VilleBot: panel link is down', $problem, 'Warning')
            Add-Content -Path $logFile -Value "[tray] $problem"
        }
        $script:tunnelProblem = $problem
        Update-State
    }

    # The bot logs "[health] warn: ..." when the PC can't keep up with playback and "[health] ok: ..." once
    # it does again. Follow the log for those and alert, at most every 10 minutes so a borderline PC doesn't nag.
    function Test-Health {
        try {
            $fs = [System.IO.File]::Open($logFile, 'Open', 'Read', 'ReadWrite')
        } catch {
            return
        }
        try {
            if ($fs.Length -lt $script:logPos) { $script:logPos = 0 } # log was cleared
            if ($fs.Length -eq $script:logPos) { return }
            [void]$fs.Seek($script:logPos, 'Begin')
            $text = $script:logTail + (New-Object System.IO.StreamReader $fs).ReadToEnd()
            $script:logPos = $fs.Length
        } finally {
            $fs.Dispose()
        }
        $lines = $text -split "`r?`n"
        $script:logTail = $lines[-1] # possibly half-written; finish it next time
        foreach ($line in ($lines | Select-Object -SkipLast 1)) {
            if ($line -match '^\[health\] warn: (.+)$') {
                $script:healthProblem = $Matches[1]
                if (((Get-Date) - $script:lastHealthAlert).TotalMinutes -ge 10) {
                    $script:lastHealthAlert = Get-Date
                    $tray.ShowBalloonTip(10000, 'VilleBot: audio may stutter', $Matches[1], 'Warning')
                }
            } elseif ($line -match '^\[health\] ok') {
                $script:healthProblem = $null
            }
        }
        Update-State
    }

    $timer = New-Object System.Windows.Forms.Timer
    $timer.Interval = 2000
    $script:ticks = 0
    $timer.add_Tick({
        $script:ticks++
        if ($script:ticks % 30 -eq 0) { Test-Tunnel } # every minute
        if ($script:bot -and -not $script:bot.HasExited) { Test-Health }
        if ($script:bot -and $script:bot.HasExited -and $tray.Text -eq 'VilleBot: running') {
            Update-State
            if (-not $script:stopping) {
                $tray.ShowBalloonTip(5000, 'VilleBot stopped', 'The bot exited. Right-click the tray icon > Open log to see why.', 'Warning')
            }
        }
    })

    try {
        $tray.Visible = $true
        Test-Tunnel
        Start-BotProcess
        $timer.Start()
        [System.Windows.Forms.Application]::Run()
    } finally {
        $timer.Stop()
        Stop-BotProcess
        $tray.Dispose()
        Remove-Item $pidFile -ErrorAction SilentlyContinue
        $mutex.ReleaseMutex()
    }
}

switch ($Action) {
    'tray' { Start-Tray }
    'start' { Start-Console }
    'stop' { Stop-Bot }
    'autostart-on' {
        $shell = New-Object -ComObject WScript.Shell
        $lnk = $shell.CreateShortcut($shortcut)
        # conhost --headless gives PowerShell a console with no window. Plain -WindowStyle Hidden can't hide it
        # when Windows Terminal is the default terminal app, and closing that window would kill the tray.
        $lnk.TargetPath = Join-Path $env:windir 'System32\conhost.exe'
        $lnk.Arguments = "--headless `"$(Join-Path $PSHOME 'powershell.exe')`" -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" tray"
        $lnk.WorkingDirectory = $root
        $lnk.Save()
        Write-Host 'Autostart on: the tray icon and bot start when you log in.'
    }
    'autostart-off' {
        Remove-Item $shortcut -ErrorAction SilentlyContinue
        Write-Host 'Autostart off.'
    }
}
