# 设置快捷方式身份.ps1 —— 给 .lnk 写 AppUserModelID（2026-10-13 收进项目，原在 %TEMP% 会丢）
# 用法: powershell -NoProfile -File scripts\设置快捷方式身份.ps1 -Lnk <快捷方式路径> -Aumid <身份>
#
# ⚠⚠ 2026-10-13 复测结论（别再反复试了）：这台 Windows 上 shell link 属性处理器**拒绝**写入
#   PKEY_AppUserModel_ID —— GPS_READWRITE 的 store 上 SetValue 返回 S_FALSE(0x00000001)、
#   Commit 返回 S_OK，但 .lnk 文件**一个字节都没变**（mtime 不动、文件里也搜不到那串身份）。
#   换 IShellItem2::GetPropertyStore、换 flags、在刚创建的新 .lnk 上写，四种组合全试过，结论一样。
#   旧版这个脚本**不看 HRESULT**，于是每次都打印 "[ok]" 骗人（找原因找半天）。
#   现在：逐个 HRESULT 打出来 + 写前写后比 SHA256 + 回读，**只有文件真的变了**才说 [已写入]。
#
# ★ 身份的正确拿法（不用写 .lnk）：从**正在运行**的任务栏按钮右键 →「固定到任务栏」，
#   Windows 会把它生成的那条快捷方式连身份一起写好；运行时的图标/名字来自 exe 本身
#   （打包时 rcedit 写进去的图标 + ProductName），不依赖这条属性。

param([string]$Lnk, [string]$Aumid)

$ErrorActionPreference = 'Continue'
if (-not $Lnk -or -not $Aumid) { Write-Output '用法: 设置快捷方式身份.ps1 -Lnk <快捷方式路径> -Aumid <身份>'; exit 2 }
if (-not (Test-Path -LiteralPath $Lnk)) { Write-Output ('[跳过] 找不到快捷方式: ' + $Lnk); exit 2 }

$cs = @'
using System;
using System.Runtime.InteropServices;
public static class AumidSet {
  [StructLayout(LayoutKind.Sequential, Pack = 4)] public struct PROPERTYKEY { public Guid fmtid; public uint pid; }
  [StructLayout(LayoutKind.Explicit)] public struct PROPVARIANT { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr p; }
  [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPropertyStore {
    [PreserveSig] int GetCount(out uint c);
    [PreserveSig] int GetAt(uint i, out PROPERTYKEY k);
    [PreserveSig] int GetValue(ref PROPERTYKEY k, out PROPVARIANT v);
    [PreserveSig] int SetValue(ref PROPERTYKEY k, ref PROPVARIANT v);
    [PreserveSig] int Commit();
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern int SHGetPropertyStoreFromParsingName(string path, IntPtr pbc, int flags, ref Guid riid, out IPropertyStore store);
  static PROPERTYKEY Key() { var k = new PROPERTYKEY(); k.fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"); k.pid = 5; return k; }

  // 返回 "hr 全记录 + 是否两个都 S_OK"；不抛异常，绝不吞 HRESULT
  public static string Set(string lnkPath, string aumid) {
    Guid iid = new Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99");
    IPropertyStore store;
    int hrOpen = SHGetPropertyStoreFromParsingName(lnkPath, IntPtr.Zero, 2, ref iid, out store);
    if (hrOpen != 0) return "open=0x" + hrOpen.ToString("X8") + " ok=False";
    var key = Key();
    var pv = new PROPVARIANT(); pv.vt = 31; pv.p = Marshal.StringToCoTaskMemUni(aumid);
    int hrSet = store.SetValue(ref key, ref pv);
    int hrCommit = store.Commit();
    Marshal.FreeCoTaskMem(pv.p);
    Marshal.ReleaseComObject(store);
    return "open=0x" + hrOpen.ToString("X8") + " set=0x" + hrSet.ToString("X8") + " commit=0x" + hrCommit.ToString("X8")
      + " ok=" + (hrSet == 0 && hrCommit == 0);
  }

  public static string Get(string lnkPath) {
    Guid iid = new Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99");
    IPropertyStore store;
    int hr = SHGetPropertyStoreFromParsingName(lnkPath, IntPtr.Zero, 2, ref iid, out store);
    if (hr != 0) return "";
    var k = Key(); PROPVARIANT v;
    int hrGet = store.GetValue(ref k, out v);
    string r = (hrGet == 0 && v.vt == 31 && v.p != IntPtr.Zero) ? Marshal.PtrToStringUni(v.p) : "";
    Marshal.ReleaseComObject(store);
    return r;
  }
}
'@
if (-not ('AumidSet' -as [type])) { Add-Type -TypeDefinition $cs -Language CSharp }

$before = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($Lnk))
$res = [AumidSet]::Set($Lnk, $Aumid)
$after = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($Lnk))
$changed = ($before -ne $after)
$read = [AumidSet]::Get($Lnk)

if ($changed -and $read -eq $Aumid) {
  Write-Output ('[已写入] ' + $Lnk + '  身份=' + $read + '  (' + $res + ')')
  exit 0
}
if ($changed) {
  Write-Output ('[写了一半] ' + $Lnk + ' 文件变了但回读不一致（读到「' + $read + '」）  (' + $res + ')')
  exit 1
}
Write-Output ('[写不进去] ' + $Lnk + '  —— Windows 拒绝写入，文件一个字节没变  (' + $res + ')')
Write-Output '            这不是脚本的错，是这台机器上 shell link 属性处理器的行为（见本文件顶部注释）。'
Write-Output '            要这条身份请用：任务栏上右键正在跑的按钮 →「固定到任务栏」（Windows 自己写）。'
exit 1
