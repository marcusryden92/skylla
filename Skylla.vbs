' Double-click launcher: starts skylla (Electron dashboard) with no console window.
' Paths are resolved from this script's own location, so the clone works anywhere.
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = dir
sh.Run "node """ & dir & "\src\index.js""", 0, False
