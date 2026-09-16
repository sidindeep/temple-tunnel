@echo off
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul
if errorlevel 1 exit /b 1
if not exist "%~dp0..\vendor\network-guard" mkdir "%~dp0..\vendor\network-guard"
cl /nologo /std:c++17 /EHsc /W4 /O2 /MT /DUNICODE /D_UNICODE "%~dp0network-guard.cpp" /Fo"%~dp0..\vendor\network-guard\network-guard.obj" /Fe"%~dp0..\vendor\network-guard\network-guard.exe" /link /SUBSYSTEM:CONSOLE /DYNAMICBASE /NXCOMPAT
