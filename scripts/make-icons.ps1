# สร้างไอคอนแอป (PWA) ใน public/icons — รันบน Windows: powershell -File scripts/make-icons.ps1 -OutDir public/icons
param([string]$OutDir)
Add-Type -AssemblyName System.Drawing
New-Item -ItemType Directory -Force $OutDir | Out-Null

function New-Icon([int]$size, [string]$path, [double]$contentScale, [bool]$rounded) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)
  $green = [System.Drawing.ColorTranslator]::FromHtml('#0D5C3B')
  $amber = [System.Drawing.ColorTranslator]::FromHtml('#F2B01E')
  $bg = New-Object System.Drawing.SolidBrush $green
  if ($rounded) {
    $r = [int]($size * 0.22)
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $p.AddArc(0, 0, $r * 2, $r * 2, 180, 90)
    $p.AddArc($size - $r * 2, 0, $r * 2, $r * 2, 270, 90)
    $p.AddArc($size - $r * 2, $size - $r * 2, $r * 2, $r * 2, 0, 90)
    $p.AddArc(0, $size - $r * 2, $r * 2, $r * 2, 90, 90)
    $p.CloseFigure()
    $g.FillPath($bg, $p)
  } else {
    $g.FillRectangle($bg, 0, 0, $size, $size)
  }
  # แถบเส้นถนนสีเหลืองด้านล่าง (เหมือนหัวเว็บ)
  $lane = New-Object System.Drawing.SolidBrush $amber
  $laneH = [Math]::Max(2, [int]($size * 0.045))
  $laneY = [int]($size * (0.5 + $contentScale * 0.42))
  $dash = [int]($size * 0.12); $gap = [int]($size * 0.07)
  $span = $size * $contentScale
  $n = [Math]::Max(1, [Math]::Floor(($span + $gap) / ($dash + $gap)))
  $x0 = [int](($size - ($n * $dash + ($n - 1) * $gap)) / 2)
  for ($i = 0; $i -lt $n; $i++) { $g.FillRectangle($lane, $x0 + $i * ($dash + $gap), $laneY, $dash, $laneH) }
  # โล่ + เครื่องหมายถูก
  $s = $size * $contentScale
  $cx = $size / 2.0; $top = $size * 0.5 - $s * 0.36
  $shield = New-Object System.Drawing.Drawing2D.GraphicsPath
  $pts = @(
    (New-Object System.Drawing.PointF ($cx), ($top)),
    (New-Object System.Drawing.PointF ($cx + $s * 0.28), ($top + $s * 0.12)),
    (New-Object System.Drawing.PointF ($cx + $s * 0.28), ($top + $s * 0.36))
  )
  $shield.AddLine($pts[0], $pts[1])
  $shield.AddLine($pts[1], $pts[2])
  $shield.AddBezier(($cx + $s * 0.28), ($top + $s * 0.36), ($cx + $s * 0.28), ($top + $s * 0.56), ($cx + $s * 0.12), ($top + $s * 0.66), ($cx), ($top + $s * 0.72))
  $shield.AddBezier(($cx), ($top + $s * 0.72), ($cx - $s * 0.12), ($top + $s * 0.66), ($cx - $s * 0.28), ($top + $s * 0.56), ($cx - $s * 0.28), ($top + $s * 0.36))
  $shield.AddLine(($cx - $s * 0.28), ($top + $s * 0.36), ($cx - $s * 0.28), ($top + $s * 0.12))
  $shield.CloseFigure()
  $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), ([float]($s * 0.055))
  $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
  $g.DrawPath($pen, $shield)
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round; $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $g.DrawLines($pen, [System.Drawing.PointF[]]@(
    (New-Object System.Drawing.PointF ($cx - $s * 0.11), ($top + $s * 0.37)),
    (New-Object System.Drawing.PointF ($cx - $s * 0.025), ($top + $s * 0.455)),
    (New-Object System.Drawing.PointF ($cx + $s * 0.13), ($top + $s * 0.28))
  ))
  $g.Dispose()
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

New-Icon 192 (Join-Path $OutDir 'icon-192.png') 0.78 $true
New-Icon 512 (Join-Path $OutDir 'icon-512.png') 0.78 $true
New-Icon 512 (Join-Path $OutDir 'icon-maskable-512.png') 0.58 $false   # Android: เนื้อหาอยู่ในวงกลม 80%
New-Icon 180 (Join-Path $OutDir 'apple-touch-icon.png') 0.72 $false    # iOS ปัดมุมเอง ต้องไม่โปร่งใส
New-Icon 32 (Join-Path $OutDir 'favicon-32.png') 0.9 $true
Get-ChildItem $OutDir | ForEach-Object { "$($_.Name) $($_.Length)" }
