; Replace Tauri's process-name kill sweep with path-scoped graceful shutdown.
!macroundef CheckIfAppIsRunning
!macro CheckIfAppIsRunning executableName productName
  InitPluginsDir
  !ifdef MDPLUS_UNINSTALL_CONTEXT
    CopyFiles /SILENT "$INSTDIR\${executableName}" "$PLUGINSDIR\mdplus-maintenance.exe"
  !else
    File /oname=$PLUGINSDIR\mdplus-maintenance.exe "${MAINBINARYSRCPATH}"
  !endif
  nsExec::ExecToStack '"$PLUGINSDIR\mdplus-maintenance.exe" --prepare-update "$INSTDIR\${executableName}"'
  Pop $0
  Pop $1
  ${If} $0 != 0
    SetErrorLevel 2
    MessageBox MB_OK|MB_ICONSTOP "MDPlus cannot be updated while the old application or its files are in use.$\r$\nSave your documents, close MDPlus, and retry.$\r$\n$1" /SD IDOK
    Abort
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  nsExec::ExecToStack '"$PLUGINSDIR\mdplus-maintenance.exe" --verify-install "$INSTDIR\${MAINBINARYNAME}.exe"'
  Pop $0
  Pop $1
  ${If} $0 != 0
    SetErrorLevel 2
    MessageBox MB_OK|MB_ICONSTOP "MDPlus installation verification failed. Do not launch this incomplete installation.$\r$\n$1" /SD IDOK
    Abort
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !define MDPLUS_UNINSTALL_CONTEXT
!macroend
