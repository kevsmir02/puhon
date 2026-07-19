; "Open in Puhon" shell verbs for folders, folder backgrounds, and drives.
; HKCU matches installer currentUser scope. %V = clicked path.
; NoWorkingDirectory keeps Explorer from overriding %V (System32 on Drive).

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInPuhon" "" "Open in Puhon"
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInPuhon" "Icon" '"$INSTDIR\puhon.exe",0'
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInPuhon" "NoWorkingDirectory" ""
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInPuhon\command" "" '"$INSTDIR\puhon.exe" "%V"'

  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInPuhon" "" "Open in Puhon"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInPuhon" "Icon" '"$INSTDIR\puhon.exe",0'
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInPuhon" "NoWorkingDirectory" ""
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInPuhon\command" "" '"$INSTDIR\puhon.exe" "%V"'

  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInPuhon" "" "Open in Puhon"
  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInPuhon" "Icon" '"$INSTDIR\puhon.exe",0'
  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInPuhon" "NoWorkingDirectory" ""
  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInPuhon\command" "" '"$INSTDIR\puhon.exe" "%V"'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey HKCU "Software\Classes\Directory\shell\OpenInPuhon"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\OpenInPuhon"
  DeleteRegKey HKCU "Software\Classes\Drive\shell\OpenInPuhon"
!macroend
