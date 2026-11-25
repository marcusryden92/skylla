' Double-click launcher: starts skylla (Electron dashboard) with no console window.
' The orchestrator starts idle and waits for instructions in the dashboard input bar.
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "C:\Users\Marcus\skylla"
sh.Run "node ""C:\Users\Marcus\skylla\src\index.js""", 0, False
