; DeepSeek Harness GUI —— 安装位置固定到 D 盘（铁律：不许装 C 盘）
;
; 为什么需要这个文件：
;   1) electron-builder 的 nsis 目标默认把 per-user 安装目录定成 %LOCALAPPDATA%\Programs\<app>（C 盘）✗
;   2) 「向导式安装器 + /D 指定目录」这条路实测**不能自我升级**：安装路径没写进注册表 InstallLocation
;      （实测 InstallLocation=[]），electron-updater 升级时找不到旧目录 ⇒ 卸载完就没装回去，**程序直接消失** ✗
;   官方推荐做法：在 preInit 宏里先把 InstallLocation 写进注册表，安装器与 electron-updater 都会读它
;   ⇒ 装到 D 盘、且升级**原地覆盖**（2026-09-26 实测）。
;
; 位置一旦定下就别改：改了等于换安装目录，升级会当作新装（老目录残留）。

!macro preInit
  ; 两个注册表视图都写一遍（安装器在 32/64 位视图下读取不一致）
  SetRegView 64
  WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "D:\software\DeepSeek-Harness-GUI"
  WriteRegExpandStr HKCU "${UNINSTALL_REGISTRY_KEY}" InstallLocation "D:\software\DeepSeek-Harness-GUI"
  SetRegView 32
  WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "D:\software\DeepSeek-Harness-GUI"
  WriteRegExpandStr HKCU "${UNINSTALL_REGISTRY_KEY}" InstallLocation "D:\software\DeepSeek-Harness-GUI"
!macroend

!macro customInit
  ; 双保险：安装前若旧版本还开着，先请它退出（避免文件占用导致覆盖失败）
  nsExec::ExecToLog 'taskkill /IM "DeepSeek Harness GUI.exe" /F'
!macroend
