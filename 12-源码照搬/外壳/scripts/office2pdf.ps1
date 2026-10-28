# office2pdf.ps1 -- convert one Office document to PDF with the locally installed Microsoft Office.
# Called by main.js (kun:file:toPdf) so the preview panel can show Word / Excel / PowerPoint.
# Contract: exit 0 + the PDF exists  => success;  anything else => failure (renderer falls back to a card).
# Keep this file PURE ASCII (no Chinese) so PowerShell 5.1 never mis-decodes it.
param(
  [Parameter(Mandatory = $true)][string]$In,
  [Parameter(Mandatory = $true)][string]$Out,
  [Parameter(Mandatory = $true)][string]$Kind   # word | excel | ppt
)

$ErrorActionPreference = 'Stop'
$In = [IO.Path]::GetFullPath($In)
$Out = [IO.Path]::GetFullPath($Out)

if (-not (Test-Path -LiteralPath $In)) { Write-Output 'FAIL: input not found'; exit 2 }
$dir = [IO.Path]::GetDirectoryName($Out)
if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
if (Test-Path -LiteralPath $Out) { Remove-Item -LiteralPath $Out -Force -ErrorAction SilentlyContinue }

# msoAutomationSecurityForceDisable = 3 (never run macros from an opened document)
$SEC = 3

function Done {
  param([string]$tag)
  $ok = $false
  try { $ok = (Test-Path -LiteralPath $Out) -and ((Get-Item -LiteralPath $Out).Length -gt 0) } catch { $ok = $false }
  # release COM handles so the Office process can really exit
  [GC]::Collect(); [GC]::WaitForPendingFinalizers(); [GC]::Collect()
  if ($ok) { Write-Output "OK $tag"; exit 0 }
  Write-Output "FAIL: no PDF produced ($tag)"; exit 3
}

switch ($Kind) {

  'word' {
    $app = $null; $doc = $null
    try {
      $app = New-Object -ComObject Word.Application
      $app.Visible = $false
      $app.DisplayAlerts = 0
      $app.AutomationSecurity = $SEC
      # Open(FileName, ConfirmConversions=$false, ReadOnly=$true, AddToRecentFiles=$false)
      $doc = $app.Documents.Open($In, $false, $true, $false)
      $doc.ExportAsFixedFormat($Out, 17)          # 17 = wdExportFormatPDF
    } catch {
      if ($doc) { try { $doc.Close(0) } catch { } ; $doc = $null }
      if ($app) {
        try {
          $doc = $app.Documents.Open($In, $false, $true, $false)
          $doc.SaveAs2($Out, 17)                  # 17 = wdFormatPDF (fallback path)
        } catch { Write-Output ("FAIL: word " + $_.Exception.Message) }
      } else { Write-Output ("FAIL: word " + $_.Exception.Message) }
    } finally {
      if ($doc) { try { $doc.Close(0) } catch { } }
      if ($app) { try { $app.Quit() } catch { } }
    }
    Done 'word'
  }

  'excel' {
    $app = $null; $wb = $null
    try {
      $app = New-Object -ComObject Excel.Application
      $app.Visible = $false
      $app.DisplayAlerts = $false
      $app.AutomationSecurity = $SEC
      # Open(FileName, UpdateLinks=0, ReadOnly=$true)
      $wb = $app.Workbooks.Open($In, 0, $true)
      $wb.ExportAsFixedFormat(0, $Out)            # 0 = xlTypePDF
    } catch {
      Write-Output ("FAIL: excel " + $_.Exception.Message)
    } finally {
      if ($wb) { try { $wb.Close($false) } catch { } }
      if ($app) { try { $app.Quit() } catch { } }
    }
    Done 'excel'
  }

  'ppt' {
    $app = $null; $pres = $null
    try {
      # PowerPoint refuses Visible=$false in some builds -- leave the window alone, just open hidden.
      $app = New-Object -ComObject PowerPoint.Application
      $app.AutomationSecurity = $SEC
      # Open(FileName, ReadOnly=$true, Untitled=$false, WithWindow=$false)
      $pres = $app.Presentations.Open($In, $true, $false, $false)
      $pres.SaveAs($Out, 32)                      # 32 = ppSaveAsPDF
    } catch {
      Write-Output ("FAIL: ppt " + $_.Exception.Message)
    } finally {
      if ($pres) { try { $pres.Close() } catch { } }
      if ($app) { try { $app.Quit() } catch { } }
    }
    Done 'ppt'
  }

  default {
    Write-Output "FAIL: unknown kind '$Kind'"
    exit 4
  }
}
