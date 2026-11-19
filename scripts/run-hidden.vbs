' run-hidden.vbs - launch a command line with NO visible window.
'
' Windows Task Scheduler, when a task runs in the user's interactive session,
' shows a console window for the lifetime of any console program it launches
' (node.exe, powershell.exe). For a task that fires every few minutes that is a
' constant flash that steals focus and disrupts typing. wscript.exe itself has
' no console, and WshShell.Run(cmd, 0, False) starts the real command with
' window style 0 (hidden) and returns immediately - so the work runs fully in
' the background with nothing on screen.
'
' Usage (from a scheduled task's Action):
'   Program:   wscript.exe
'   Arguments: "<your aiTeam folder>\scripts\run-hidden.vbs" "<exe>" "<arg1>" "<arg2>" ...
' Each token is passed as its own quoted argument so paths with spaces survive.
Option Explicit
Dim shell, args, cmd, i
Set shell = CreateObject("WScript.Shell")
Set args = WScript.Arguments
cmd = ""
For i = 0 To args.Count - 1
  If i > 0 Then cmd = cmd & " "
  cmd = cmd & """" & args(i) & """"
Next
' 0 = hidden window, False = don't wait for it to finish.
shell.Run cmd, 0, False
