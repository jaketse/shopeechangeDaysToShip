!include "FileFunc.nsh"

Function EnsureInstallDirSuffix
  ${GetFileName} "$INSTDIR" $R0
  StrCmp "$R0" "shopeeChangeDTS" done
  StrCpy $INSTDIR "$INSTDIR\\shopeeChangeDTS"
done:
FunctionEnd

Function .onVerifyInstDir
  Call EnsureInstallDirSuffix
FunctionEnd
