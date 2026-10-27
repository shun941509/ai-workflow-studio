# Actual WinRT OCR; fail when no requested language is installed. No text fallback is used.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]
    $null = [Windows.Storage.FileAccessMode, Windows.Storage, ContentType=WindowsRuntime]
    $null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime]
    $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
    $null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
    $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
    $null = [Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType=WindowsRuntime]
    $null = [Windows.Globalization.Language, Windows.Globalization, ContentType=WindowsRuntime]
    $awaitMethod = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation'+[char]96+'1' } | Select-Object -First 1
    function Await-Operation($operation, [Type]$resultType) {
        # Bound every asynchronous native call; timed-out operations are not represented as success.
        $task = $awaitMethod.MakeGenericMethod($resultType).Invoke($null, @($operation))
        if (-not $task.Wait(30000)) { throw 'Windows OCR operation timed out.' }
        return $task.Result
    }
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
    if (-not [System.IO.Path]::IsPathRooted($request.imagePath)) { throw 'Absolute image path required.' }
    $language = [Windows.Globalization.Language]::new([string]$request.language)
    if (-not [Windows.Media.Ocr.OcrEngine]::IsLanguageSupported($language)) { throw 'Requested Windows OCR language is not installed.' }
    $file = Await-Operation ([Windows.Storage.StorageFile]::GetFileFromPathAsync($request.imagePath)) ([Windows.Storage.StorageFile])
    $stream = Await-Operation ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    try {
        $decoder = Await-Operation ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
        $bitmap = Await-Operation ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
        try {
            $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
            if ($null -eq $engine -or $bitmap.PixelWidth -gt [Windows.Media.Ocr.OcrEngine]::MaxImageDimension -or $bitmap.PixelHeight -gt [Windows.Media.Ocr.OcrEngine]::MaxImageDimension) { throw 'OCR engine or supported image dimensions unavailable.' }
            $recognized = Await-Operation ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
            $words = @(); $lineIndex = 0
            foreach ($line in $recognized.Lines) {
                foreach ($word in $line.Words) { $rect=$word.BoundingRect; $words += @{text=$word.Text;line=$lineIndex;x=$rect.X;y=$rect.Y;width=$rect.Width;height=$rect.Height} }
                $lineIndex++
            }
            [Console]::WriteLine((@{engine='Windows.Media.Ocr';language=$engine.RecognizerLanguage.LanguageTag;width=$bitmap.PixelWidth;height=$bitmap.PixelHeight;words=@($words)} | ConvertTo-Json -Depth 8 -Compress))
        } finally { if ($null -ne $bitmap) { $bitmap.Dispose() } }
    } finally { if ($null -ne $stream) { $stream.Dispose() } }
} catch { [Console]::Error.WriteLine('OCR failed: '+$_.Exception.Message); exit 1 }
