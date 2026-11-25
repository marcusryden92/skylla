# skylla installer: add repo to user PATH + create the desktop-style shortcut.
# Run via install.cmd (or: powershell -ExecutionPolicy Bypass -File install.ps1)
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path

# 1. add this folder to the user PATH (so `skylla` works in any terminal)
$user = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($user -split ';') -notcontains $dir) {
  [Environment]::SetEnvironmentVariable('Path', "$user;$dir", 'User')
  Write-Output "added to PATH: $dir (open a new terminal to use 'skylla')"
} else {
  Write-Output "already on PATH: $dir"
}

# 2. shortcut with icon, pointing at the hidden-console launcher
$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut("$dir\Skylla.lnk")
$lnk.TargetPath = "$env:windir\System32\wscript.exe"
$lnk.Arguments = """$dir\Skylla.vbs"""
$lnk.WorkingDirectory = $dir
$lnk.IconLocation = "$dir\assets\icon.ico,0"
$lnk.Description = "skylla multi-agent dashboard"
$lnk.Save()
Write-Output "shortcut created: $dir\Skylla.lnk"
