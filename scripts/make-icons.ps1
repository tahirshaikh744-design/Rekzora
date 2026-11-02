# Generates app icons for Rekzora (NEURON TS LABS) using GDI+.
# Emits:
#   assets/icon.png      256x256 (electron-builder converts too)
#   assets/icon-32.png   32x32   (window + drag-thumbnail icons)
#   assets/icon.ico      true multi-resolution ICO: 16,32,48,64,128,256
#                        (>=256 layers keep electron-builder's icon check happy)
Add-Type -AssemblyName System.Drawing

$assetsDir = Join-Path (Join-Path $PSScriptRoot '..') 'assets'
New-Item -ItemType Directory -Force -Path $assetsDir | Out-Null

function New-Icon {
    param([int]$size)

    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)

    $sizeF = [float]$size
    $radius = $sizeF * 0.225
    $d = $radius * 2.0

    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc(0.0, 0.0, $d, $d, 180.0, 90.0)
    $path.AddArc($sizeF - $d, 0.0, $d, $d, 270.0, 90.0)
    $path.AddArc($sizeF - $d, $sizeF - $d, $d, $d, 0.0, 90.0)
    $path.AddArc(0.0, $sizeF - $d, $d, $d, 90.0, 90.0)
    $path.CloseFigure()

    $rect = New-Object System.Drawing.RectangleF(0.0, 0.0, $sizeF, $sizeF)
    $c1 = [System.Drawing.Color]::FromArgb(255, 27, 27, 33)
    $c2 = [System.Drawing.Color]::FromArgb(255, 13, 13, 17)
    $bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $c1, $c2, 90.0)
    $g.FillPath($bg, $path)

    # soft glow
    $cx = $sizeF * 0.5
    $cy = $sizeF * 0.5
    $gr = $sizeF * 0.38
    $gp = New-Object System.Drawing.Drawing2D.GraphicsPath
    $gp.AddEllipse(($cx - $gr), ($cy - $gr), ($gr * 2.0), ($gr * 2.0))
    $pgb = New-Object System.Drawing.Drawing2D.PathGradientBrush($gp)
    $pgb.CenterColor = [System.Drawing.Color]::FromArgb(110, 255, 59, 48)
    $pgb.SurroundColors = @([System.Drawing.Color]::FromArgb(0, 255, 59, 48))
    $g.FillPath($pgb, $gp)

    # main dot
    $dr = $sizeF * 0.22
    $drect = New-Object System.Drawing.RectangleF(($cx - $dr), ($cy - $dr), ($dr * 2.0), ($dr * 2.0))
    $dot = New-Object System.Drawing.Drawing2D.LinearGradientBrush($drect, [System.Drawing.Color]::FromArgb(255, 255, 88, 80), [System.Drawing.Color]::FromArgb(255, 232, 34, 38), 90.0)
    $g.FillEllipse($dot, ($cx - $dr), ($cy - $dr), ($dr * 2.0), ($dr * 2.0))

    # highlight
    $hp = New-Object System.Drawing.Drawing2D.GraphicsPath
    $hp.AddEllipse(($cx - $dr * 0.5), ($cy - $dr * 0.72), ($dr * 0.85), ($dr * 0.5))
    $hgb = New-Object System.Drawing.Drawing2D.PathGradientBrush($hp)
    $hgb.CenterColor = [System.Drawing.Color]::FromArgb(130, 255, 255, 255)
    $hgb.SurroundColors = @([System.Drawing.Color]::FromArgb(0, 255, 255, 255))
    $g.FillPath($hgb, $hp)

    $g.Dispose()
    return ,$bmp
}

function Get-PngBytes {
    param($bmp)
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    return $ms.ToArray()
}

# classic raw-BGRA icon entry (what Windows and resedit expect):
# BITMAPINFOHEADER + pixel rows bottom-up + zero AND mask
function New-RawIconEntry {
    param($bmp)
    $w = $bmp.Width
    $h = $bmp.Height
    $rect = New-Object System.Drawing.Rectangle(0, 0, $w, $h)
    $bits = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $len = [int]([math]::Abs($bits.Stride) * $h)
    $topDown = New-Object byte[] $len
    [System.Runtime.InteropServices.Marshal]::Copy($bits.Scan0, $topDown, 0, $len)
    $bmp.UnlockBits($bits)

    $stride = $w * 4
    $xor = New-Object byte[] $len
    for ($y = 0; $y -lt $h; $y++) {
        [Array]::Copy($topDown, $y * $stride, $xor, ($h - 1 - $y) * $stride, $stride)
    }

    $maskStride = [int][math]::Ceiling([math]::Ceiling($w / 8) / 4) * 4
    $and = New-Object byte[] ($maskStride * $h)

    $hdr = New-Object byte[] 40
    [BitConverter]::GetBytes([UInt32]40).CopyTo($hdr, 0)      # biSize
    [BitConverter]::GetBytes([Int32]$w).CopyTo($hdr, 4)       # biWidth
    [BitConverter]::GetBytes([Int32]($h * 2)).CopyTo($hdr, 8) # biHeight (xor+and)
    [BitConverter]::GetBytes([UInt16]1).CopyTo($hdr, 12)      # planes
    [BitConverter]::GetBytes([UInt16]32).CopyTo($hdr, 14)     # bpp = 32

    $out = New-Object byte[] (40 + $len + $and.Length)
    [Array]::Copy($hdr, $out, 40)
    [Array]::Copy($xor, 0, $out, 40, $len)
    [Array]::Copy($and, 0, $out, 40 + $len, $and.Length)
    return , $out
}

# --- plain PNGs -------------------------------------------------------
$big = New-Icon 256
$big.Save((Join-Path $assetsDir 'icon.png'), [System.Drawing.Imaging.ImageFormat]::Png)

$mid = New-Icon 32
$mid.Save((Join-Path $assetsDir 'icon-32.png'), [System.Drawing.Imaging.ImageFormat]::Png)

# --- multi-resolution ICO (raw 32bpp layers: 16,32,48,64,128,256) -----
$sizes = 16, 32, 48, 64, 128, 256
$payloads = @()
foreach ($s in $sizes) {
    $b = New-Icon $s
    $raw = New-RawIconEntry $b
    $b.Dispose()
    $payloads += , $raw
}
$payloadSizes = foreach ($p in $payloads) { $p.Length }

$dir = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($dir)
$bw.Write([UInt16]0)                  # reserved
$bw.Write([UInt16]1)                  # type: icon
$bw.Write([UInt16]$sizes.Count)
$offset = 6 + ($sizes.Count * 16)     # header + directory
foreach ($s in $sizes) {
    $i = [array]::IndexOf($sizes, $s)
    $w = if ($s -eq 256) { [byte]0 } else { [byte]$s }
    $bw.Write([byte]$w)               # width  (0 = 256)
    $bw.Write([byte]$w)               # height (0 = 256)
    $bw.Write([byte]0)                # color count
    $bw.Write([byte]0)                # reserved
    $bw.Write([UInt16]1)              # planes
    $bw.Write([UInt16]32)             # bpp
    $bw.Write([UInt32]([int]$payloadSizes[$i]))
    $bw.Write([UInt32][int]$offset)
    $offset += $payloadSizes[$i]
}
foreach ($raw in $payloads) {
    $bw.Write($raw)
}
$bw.Flush()
[System.IO.File]::WriteAllBytes((Join-Path $assetsDir 'icon.ico'), $dir.ToArray())

Write-Host ('Icons generated in assets/ (ico layers: ' + ($sizes -join ',') + ').')
