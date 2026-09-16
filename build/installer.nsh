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
