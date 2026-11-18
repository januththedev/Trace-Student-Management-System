param([Parameter(Mandatory=$true)][string]$Manifest)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $speaker.SelectVoice('Microsoft David Desktop')
  $speaker.Rate = 0
  $items = Get-Content -LiteralPath $Manifest -Raw -Encoding UTF8 | ConvertFrom-Json
  foreach ($item in $items) {
    $speaker.SetOutputToWaveFile($item.path)
    $speaker.Speak($item.text)
    $speaker.SetOutputToNull()
  }
} finally { $speaker.Dispose() }
