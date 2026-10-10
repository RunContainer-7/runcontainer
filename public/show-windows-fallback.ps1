param(
  [string]$Title = 'RunContainer',
  [string]$Message = 'The app did not appear inside the sandbox after the startup timeout.',
  [string]$Detail = 'Would you like to launch it on the desktop instead?'
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
$owner.CreateControl() | Out-Null

$result = [System.Windows.Forms.MessageBox]::Show(
  $owner,
  $Detail,
  $Title,
  [System.Windows.Forms.MessageBoxButtons]::YesNo,
  [System.Windows.Forms.MessageBoxIcon]::Warning,
  [System.Windows.Forms.MessageBoxDefaultButton]::Button1,
  [System.Windows.Forms.MessageBoxOptions]::ServiceNotification
)

if ($result -eq [System.Windows.Forms.DialogResult]::Yes) {
  Write-Output 'YES'
} else {
  Write-Output 'NO'
}
