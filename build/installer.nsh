!macro customHeader
  !ifndef BUILD_UNINSTALLER
    ; The client runs elevated. A medium-integrity installer cannot close it.
    ; Keep the existing per-user/all-users selection; elevate the installer only.
    RequestExecutionLevel admin
  !endif
!macroend

!macro customCheckAppRunning
  Push $R0
  Push $R1
  ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
  ${If} $R0 == 0
    DetailPrint "Closing ${PRODUCT_NAME}..."
    InitPluginsDir
    ; File otherwise extracts to $OUTDIR, not to the plugin directory.
    File "/oname=$PLUGINSDIR\temple-close-app.ps1" "${BUILD_RESOURCES_DIR}\close-app.ps1"
    ; nsProcess CloseProcess itself forces exit after 3s. Use a helper instead
    ; to give Electron 10s and retain identities of its cores if the parent exits.
    nsExec::ExecToStack /TIMEOUT=20000 '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\temple-close-app.ps1" -ProcessName "${APP_EXECUTABLE_FILENAME}"'
    Pop $R0
    Pop $R1
    ${If} $R0 == 0
      ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
    ${Else}
      StrCpy $R0 1
    ${EndIf}
  ${EndIf}

  ; nsProcess returns 603 only when the image is no longer running.
  ${If} $R0 != 603
    ${nsProcess::Unload}
    Pop $R1
    Pop $R0
    MessageBox MB_OK|MB_ICONSTOP "Temple Tunnel could not be closed automatically. Installation has stopped; no application files have been replaced." /SD IDOK
    SetErrorLevel 1
    Quit
  ${EndIf}
  ${nsProcess::Unload}
  Pop $R1
  Pop $R0
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    IfFileExists "$INSTDIR\resources\bin\network-guard.exe" 0 temple_guard_done
    nsExec::ExecToStack '"$INSTDIR\resources\bin\network-guard.exe" clear'
    Pop $0
    Pop $1
    ${If} $0 != 0
      MessageBox MB_OK|MB_ICONSTOP "Cannot remove Temple Tunnel network protection. Run this uninstaller as administrator. No application files have been removed."
      Abort
    ${EndIf}
    temple_guard_done:
  ${endif}
!macroend
