@echo off
cd /d "%~dp0"
if not exist .venv py -3 -m venv .venv
if errorlevel 1 goto fail
.venv\Scripts\python -m pip install -r requirements.txt --disable-pip-version-check
if errorlevel 1 goto fail
.venv\Scripts\python app.py %*
if errorlevel 1 goto fail
exit /b
:fail
echo Install Python 3.10 or newer and try again.
pause
