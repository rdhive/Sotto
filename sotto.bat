@echo off
rem Launcher so Sotto runs from any directory. PYTHONPATH points at core/
rem so `-m sotto` resolves without needing to cd there first.
setlocal
set "ROOT=%~dp0"
set "PYTHONPATH=%ROOT%core"
"%ROOT%.venv\Scripts\python.exe" -m sotto %*
