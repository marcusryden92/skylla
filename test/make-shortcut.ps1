$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut("C:\Users\Marcus\skylla\Skylla.lnk")
$lnk.TargetPath = "C:\Windows\System32\wscript.exe"
$lnk.Arguments = '"C:\Users\Marcus\skylla\Skylla.vbs"'
$lnk.WorkingDirectory = "C:\Users\Marcus\skylla"
$lnk.IconLocation = "C:\Users\Marcus\skylla\assets\icon.ico,0"
$lnk.Description = "skylla multi-agent dashboard"
$lnk.Save()
Write-Output "shortcut created"
