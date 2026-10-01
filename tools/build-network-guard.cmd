@echo off
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" (echo Visual Studio Installer vswhere.exe not found.& exit /b 1)
set "VSPATH="
for /f "usebackq delims=" %%I in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSPATH=%%I"
if not defined VSPATH (echo Visual Studio C++ Build Tools not found.& exit /b 1)
call "%VSPATH%\VC\Auxiliary\Build\vcvars64.bat" >nul
if errorlevel 1 exit /b 1
if not exist "%~dp0..\vendor\network-guard" mkdir "%~dp0..\vendor\network-guard"
cl /nologo /std:c++17 /EHsc /W4 /O2 /MT /DUNICODE /D_UNICODE "%~dp0network-guard.cpp" /Fo"%~dp0..\vendor\network-guard\network-guard.obj" /Fe"%~dp0..\vendor\network-guard\network-guard.exe" /link /SUBSYSTEM:CONSOLE /DYNAMICBASE /NXCOMPAT
