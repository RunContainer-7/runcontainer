param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$version = (Get-Content (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json).version
if ($version -notmatch '^\d+\.\d+\.\d+$') {
  throw 'Only stable versions can be signed by this script.'
}
$installer = Get-Item -LiteralPath $InstallerPath
if ($installer.Name -ne "RunContainer-Stable-Setup-$version.exe") {
  throw "Expected RunContainer-Stable-Setup-$version.exe."
}

# Each build uses a new certificate; it is not a publicly trusted identity.
# No private key is exported or included in the installer.
$cert = $null
$root = $null
try {
  $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=RunContainer (self-signed)' `
    -CertStoreLocation 'Cert:\CurrentUser\My' -KeyExportPolicy NonExportable `
    -HashAlgorithm SHA256 -NotAfter (Get-Date).AddYears(2)
  $signed = Set-AuthenticodeSignature -LiteralPath $installer.FullName -Certificate $cert -HashAlgorithm SHA256
  if (-not $signed.SignerCertificate -or $signed.SignerCertificate.Thumbprint -ne $cert.Thumbprint) {
    throw 'The installer was not signed with the generated certificate.'
  }

  if ($env:GITHUB_ACTIONS -eq 'true') {
    # Verify Windows Authenticode cryptography and file integrity on the disposable
    # GitHub runner. Never install a trust anchor on an end user's computer.
    $root = New-Object System.Security.Cryptography.X509Certificates.X509Store('Root', 'CurrentUser')
    $root.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
    $root.Add($cert)
    $verified = Get-AuthenticodeSignature -LiteralPath $installer.FullName
    if ($verified.Status -ne 'Valid' -or $verified.SignerCertificate.Thumbprint -ne $cert.Thumbprint) {
      throw "Authenticode verification failed: $($verified.Status) $($verified.StatusMessage)"
    }
  } else {
    # On an ordinary PC Windows cannot build a trusted chain for this certificate.
    # Check that a signature was added; don't change the machine's trust stores.
    $verified = Get-AuthenticodeSignature -LiteralPath $installer.FullName
    if (-not $verified.SignerCertificate -or $verified.SignerCertificate.Thumbprint -ne $cert.Thumbprint -or
        $verified.Status -notin @('Valid', 'UnknownError')) {
      throw "Unable to inspect the self-signed installer: $($verified.Status) $($verified.StatusMessage)"
    }
  }
  Write-Output "Self-signed $($installer.Name); Windows signature status: $($verified.Status). The certificate is not publicly trusted."
} finally {
  if ($root) {
    try { if ($cert) { $root.Remove($cert) } } finally { $root.Close() }
  }
  if ($cert) { Remove-Item -LiteralPath "Cert:\CurrentUser\My\$($cert.Thumbprint)" -DeleteKey -ErrorAction Stop }
}
