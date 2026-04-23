$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

# Set DPI awareness BEFORE loading any GUI assemblies.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class Dpi {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);
  public const int SM_XVIRTUALSCREEN = 76;
  public const int SM_YVIRTUALSCREEN = 77;
  public const int SM_CXVIRTUALSCREEN = 78;
  public const int SM_CYVIRTUALSCREEN = 79;
  public const int SM_CXSCREEN = 0;
  public const int SM_CYSCREEN = 1;
}
'@ | Out-Null
try { [Dpi]::SetProcessDpiAwarenessContext([IntPtr]::new(-4)) | Out-Null } catch { }
try { [Dpi]::SetProcessDPIAware() | Out-Null } catch { }

. "$root\vd.ps1" | Out-Null

Add-Type -AssemblyName System.Drawing | Out-Null

Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Drawing;
using System.Drawing.Imaging;
public class Kb {
  [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] p, int cb);
  [StructLayout(LayoutKind.Sequential)] public struct KI { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtra; }
  [StructLayout(LayoutKind.Explicit, Size=40)] public struct INPUT { [FieldOffset(0)] public uint type; [FieldOffset(8)] public KI ki; }
  public static void Tap(ushort[] keys) {
    INPUT[] ins = new INPUT[keys.Length * 2];
    for (int i = 0; i < keys.Length; i++) { ins[i].type = 1; ins[i].ki.wVk = keys[i]; }
    for (int i = 0; i < keys.Length; i++) { ins[keys.Length + i].type = 1; ins[keys.Length + i].ki.wVk = keys[keys.Length - 1 - i]; ins[keys.Length + i].ki.dwFlags = 2; }
    SendInput((uint)ins.Length, ins, Marshal.SizeOf(typeof(INPUT)));
  }
}
public class CapH {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", EntryPoint="GetWindowLongPtr")] public static extern IntPtr GetWindowLongPtr64(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll", EntryPoint="GetWindowLong")] public static extern IntPtr GetWindowLong32(IntPtr hWnd, int nIndex);
  public static IntPtr GetWindowLongX(IntPtr h, int i) { if (IntPtr.Size == 8) return GetWindowLongPtr64(h, i); return GetWindowLong32(h, i); }
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out int pvAttribute, int cbAttribute);
  [DllImport("user32.dll")] public static extern IntPtr GetShellWindow();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public const int GWL_EXSTYLE = -20;
  public const int WS_EX_TOOLWINDOW = 0x80;
  public const int DWMWA_CLOAKED = 14;
  public static IntPtr[] TopLevelWindows() {
    var list = new List<IntPtr>();
    EnumWindows((h, l) => { list.Add(h); return true; }, IntPtr.Zero);
    return list.ToArray();
  }
  public static bool IsCandidate(IntPtr hwnd) {
    if (hwnd == GetShellWindow()) return false;
    if (GetWindowTextLength(hwnd) == 0) return false;
    long ex = GetWindowLongX(hwnd, GWL_EXSTYLE).ToInt64();
    if ((ex & WS_EX_TOOLWINDOW) != 0) return false;
    if (IsIconic(hwnd)) return false;
    RECT r; if (!GetWindowRect(hwnd, out r)) return false;
    if (r.Right - r.Left < 40 || r.Bottom - r.Top < 40) return false;
    return true;
  }
  public static bool PaintWindowTo(IntPtr hwnd, Graphics g) {
    RECT r; if (!GetWindowRect(hwnd, out r)) return false;
    int w = r.Right - r.Left; int h = r.Bottom - r.Top;
    if (w <= 0 || h <= 0) return false;
    var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
    var t = new System.Threading.Thread(() => {
      try {
        using (var wg = Graphics.FromImage(bmp)) {
          IntPtr hdc = wg.GetHdc();
          try { PrintWindow(hwnd, hdc, 0x2); }
          finally { wg.ReleaseHdc(hdc); }
        }
      } catch {}
    });
    t.IsBackground = true;
    t.Start();
    if (!t.Join(250)) { return false; }
    try { g.DrawImage(bmp, r.Left, r.Top, w, h); } catch {}
    bmp.Dispose();
    return true;
  }
}
'@ | Out-Null

function Screen-Size {
  $sw = [Dpi]::GetSystemMetrics([Dpi]::SM_CXVIRTUALSCREEN)
  $sh = [Dpi]::GetSystemMetrics([Dpi]::SM_CYVIRTUALSCREEN)
  $sx = [Dpi]::GetSystemMetrics([Dpi]::SM_XVIRTUALSCREEN)
  $sy = [Dpi]::GetSystemMetrics([Dpi]::SM_YVIRTUALSCREEN)
  if ($sw -le 0 -or $sh -le 0) {
    $sw = [Dpi]::GetSystemMetrics([Dpi]::SM_CXSCREEN)
    $sh = [Dpi]::GetSystemMetrics([Dpi]::SM_CYSCREEN)
    $sx = 0; $sy = 0
  }
  return @{ X = $sx; Y = $sy; W = $sw; H = $sh }
}

function Save-Thumb([System.Drawing.Bitmap]$bmp, [string]$path, [int]$maxW) {
  $sw = $bmp.Width; $sh = $bmp.Height
  $tw = [int][Math]::Min($maxW, $sw)
  $th = [int][Math]::Round($sh / $sw * $tw)
  $thumb = New-Object System.Drawing.Bitmap $tw, $th
  $tg = [System.Drawing.Graphics]::FromImage($thumb)
  $tg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::Bilinear
  $tg.DrawImage($bmp, 0, 0, $tw, $th)
  $tg.Dispose()
  $tmp = "$path.tmp"
  $thumb.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)
  $thumb.Dispose()
  if (Test-Path $path) { Remove-Item $path -Force }
  Move-Item $tmp $path
}

$script:CachedWallpaper = $null
$script:CachedWallpaperPath = $null
function Get-CachedWallpaper {
  try {
    $wp = (Get-ItemProperty -Path "HKCU:\Control Panel\Desktop" -Name Wallpaper -ErrorAction Stop).Wallpaper
  } catch { $wp = $null }
  if (-not $wp -or -not (Test-Path $wp)) { return $null }
  if ($script:CachedWallpaperPath -eq $wp -and $script:CachedWallpaper) { return $script:CachedWallpaper }
  if ($script:CachedWallpaper) { try { $script:CachedWallpaper.Dispose() } catch {} }
  try { $script:CachedWallpaper = [System.Drawing.Image]::FromFile($wp); $script:CachedWallpaperPath = $wp } catch { $script:CachedWallpaper = $null }
  return $script:CachedWallpaper
}

function Capture-Current([string]$path, [int]$maxW = 640) {
  $s = Screen-Size
  $bmp = New-Object System.Drawing.Bitmap $s.W, $s.H
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen((New-Object System.Drawing.Point $s.X, $s.Y), [System.Drawing.Point]::Empty, (New-Object System.Drawing.Size $s.W, $s.H), [System.Drawing.CopyPixelOperation]::SourceCopy)
  $g.Dispose()
  Save-Thumb $bmp $path $maxW
  $bmp.Dispose()
}

function Capture-SingleDesktop([int]$index, [string]$path, [int]$maxW = 640) {
  $count = [int](Get-DesktopCount)
  $curIdx = 0
  for ($i = 0; $i -lt $count; $i++) { if (([VirtualDesktop.Desktop]::FromIndex($i)).IsVisible) { $curIdx = $i; break } }
  if ($index -eq $curIdx) {
    Capture-Current -path $path -maxW $maxW
    return
  }
  $s = Screen-Size
  $wallpaper = Get-CachedWallpaper
  $allHwnds = [CapH]::TopLevelWindows()
  $myHwnds = New-Object System.Collections.Generic.List[IntPtr]
  foreach ($hwnd in $allHwnds) {
    if (-not [CapH]::IsCandidate($hwnd)) { continue }
    $d = $null
    try { $d = [VirtualDesktop.Desktop]::FromWindow($hwnd) } catch { continue }
    if ($null -eq $d) { continue }
    $i = [int][VirtualDesktop.Desktop]::FromDesktop($d)
    if ($i -eq $index) { $myHwnds.Add($hwnd) }
  }
  $hwnds = $myHwnds.ToArray()
  [Array]::Reverse($hwnds)
  $bmp = New-Object System.Drawing.Bitmap $s.W, $s.H
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  if ($wallpaper) { $g.DrawImage($wallpaper, 0, 0, $s.W, $s.H) } else { $g.Clear([System.Drawing.Color]::FromArgb(255, 20, 24, 36)) }
  foreach ($h in $hwnds) { [CapH]::PaintWindowTo($h, $g) | Out-Null }
  $g.Dispose()
  Save-Thumb $bmp $path $maxW
  $bmp.Dispose()
}

function Capture-AllNoSwitch([string]$dir, [int]$maxW = 640) {
  $count = [int](Get-DesktopCount)
  $curIdx = 0
  for ($i = 0; $i -lt $count; $i++) { if (([VirtualDesktop.Desktop]::FromIndex($i)).IsVisible) { $curIdx = $i; break } }
  $s = Screen-Size
  $wallpaper = Get-CachedWallpaper

  $allHwnds = [CapH]::TopLevelWindows()
  $byDesktop = @{}
  for ($i = 0; $i -lt $count; $i++) { $byDesktop[$i] = New-Object System.Collections.Generic.List[IntPtr] }
  foreach ($hwnd in $allHwnds) {
    if (-not [CapH]::IsCandidate($hwnd)) { continue }
    $d = $null
    try { $d = [VirtualDesktop.Desktop]::FromWindow($hwnd) } catch { continue }
    if ($null -eq $d) { continue }
    $idx = [int][VirtualDesktop.Desktop]::FromDesktop($d)
    if ($idx -lt 0 -or $idx -ge $count) { continue }
    $byDesktop[$idx].Add($hwnd)
  }

  for ($i = 0; $i -lt $count; $i++) {
    $path = Join-Path $dir "desktop_$i.png"
    if ($i -eq $curIdx) {
      Capture-Current -path $path -maxW $maxW
      continue
    }
    $bmp = New-Object System.Drawing.Bitmap $s.W, $s.H
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    if ($wallpaper) {
      $g.DrawImage($wallpaper, 0, 0, $s.W, $s.H)
    } else {
      $g.Clear([System.Drawing.Color]::FromArgb(255, 20, 24, 36))
    }
    $hwnds = $byDesktop[$i].ToArray()
    [Array]::Reverse($hwnds)
    foreach ($h in $hwnds) { [CapH]::PaintWindowTo($h, $g) | Out-Null }
    $g.Dispose()
    Save-Thumb $bmp $path $maxW
    $bmp.Dispose()
  }
}

function Say([string]$s) { [Console]::Out.WriteLine($s); [Console]::Out.Flush() }

function Current-Index {
  $n = [int](Get-DesktopCount)
  for ($i = 0; $i -lt $n; $i++) { if (([VirtualDesktop.Desktop]::FromIndex($i)).IsVisible) { return $i } }
  return 0
}

Say "READY"

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.TrimEnd()
  if ($line.Length -gt 0 -and [int]$line[0] -eq 0xFEFF) { $line = $line.Substring(1) }
  if ($line -eq '') { continue }
  if ($line -eq 'EXIT') { break }
  try {
    if ($line -eq 'LIST') {
      $count = [int](Get-DesktopCount)
      $cur = Current-Index
      $names = @()
      for ($i = 0; $i -lt $count; $i++) {
        $n = $null
        try { $n = [VirtualDesktop.Desktop]::DesktopNameFromDesktop([VirtualDesktop.Desktop]::FromIndex($i)) } catch { }
        if (-not $n) { $n = "Desktop $($i + 1)" }
        $names += $n
      }
      $obj = [ordered]@{ count = $count; current = $cur; names = $names } | ConvertTo-Json -Compress
      Say "DATA $obj"
    }
    elseif ($line.StartsWith('CAPTURE_ALL ')) {
      $dir = $line.Substring(12)
      if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
      Capture-AllNoSwitch -dir $dir
      Say "OK"
    }
    elseif ($line.StartsWith('CAPTURE_DESKTOP ')) {
      $rest = $line.Substring(16)
      $sp = $rest.IndexOf(' ')
      $idx = [int]$rest.Substring(0, $sp)
      $p = $rest.Substring($sp + 1)
      $pdir = Split-Path -Parent $p
      if ($pdir -and -not (Test-Path $pdir)) { New-Item -ItemType Directory -Path $pdir -Force | Out-Null }
      Capture-SingleDesktop -index $idx -path $p
      Say "OK"
    }
    elseif ($line.StartsWith('CAPTURE ')) {
      $p = $line.Substring(8)
      Capture-Current -path $p
      Say "OK"
    }
    elseif ($line.StartsWith('STEP ')) {
      $dir = $line.Substring(5)
      if ($dir -eq 'LEFT') { [Kb]::Tap(@([uint16]0x11, [uint16]0x5B, [uint16]0x25)) }
      else { [Kb]::Tap(@([uint16]0x11, [uint16]0x5B, [uint16]0x27)) }
      Start-Sleep -Milliseconds 420
      Say "OK"
    }
    elseif ($line -eq 'NEW') {
      [Kb]::Tap(@([uint16]0x11, [uint16]0x5B, [uint16]0x44))
      Start-Sleep -Milliseconds 600
      Say "OK"
    }
    elseif ($line.StartsWith('RENAME ')) {
      $rest = $line.Substring(7)
      $sep = $rest.IndexOf('|')
      $idx = [int]$rest.Substring(0, $sep)
      $name = $rest.Substring($sep + 1)
      Set-DesktopName -Desktop $idx -Name $name | Out-Null
      Say "OK"
    }
    elseif ($line.StartsWith('GOTO ')) {
      $idx = [int]$line.Substring(5)
      $target = [VirtualDesktop.Desktop]::FromIndex($idx)
      # Call IVirtualDesktopManagerInternal::SwitchDesktop directly — instant jump, no cycling or Progman dance
      $bf = [System.Reflection.BindingFlags]::NonPublic -bor [System.Reflection.BindingFlags]::Instance
      $sbf = [System.Reflection.BindingFlags]::NonPublic -bor [System.Reflection.BindingFlags]::Static -bor [System.Reflection.BindingFlags]::Public
      $ivdField = [VirtualDesktop.Desktop].GetField('ivd', $bf)
      $ivd = $ivdField.GetValue($target)
      $asm = [VirtualDesktop.Desktop].Assembly
      $mgrType = $asm.GetType('VirtualDesktop.DesktopManager')
      $vdmiField = $mgrType.GetField('VirtualDesktopManagerInternal', $sbf)
      $vdmi = $vdmiField.GetValue($null)
      $vdmiType = $asm.GetType('VirtualDesktop.IVirtualDesktopManagerInternal')
      $switch = $vdmiType.GetMethod('SwitchDesktop')
      $params = $switch.GetParameters()
      if ($params.Count -eq 1) {
        $switch.Invoke($vdmi, @([object]$ivd)) | Out-Null
      } else {
        $switch.Invoke($vdmi, @([object][IntPtr]::Zero, [object]$ivd)) | Out-Null
      }
      Say "OK"
    }
    elseif ($line.StartsWith('PIN ')) {
      $h = [IntPtr][int64]$line.Substring(4)
      [VirtualDesktop.Desktop]::PinWindow($h) | Out-Null
      Say "OK"
    }
    elseif ($line.StartsWith('REMOVE ')) {
      $idx = [int]$line.Substring(7)
      Remove-Desktop -Desktop $idx | Out-Null
      Say "OK"
    }
    else {
      Say "ERR unknown $line"
    }
  } catch {
    $msg = $_.Exception.Message -replace "`r?`n", ' '
    Say "ERR $msg"
  }
}
