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
try {
  $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=RunContainer (self-signed)' `
    -CertStoreLocation 'Cert:\CurrentUser\My' -KeyExportPolicy NonExportable `
    -HashAlgorithm SHA256 -NotAfter (Get-Date).AddYears(2)
  $signed = Set-AuthenticodeSignature -LiteralPath $installer.FullName -Certificate $cert -HashAlgorithm SHA256
  if (-not $signed.SignerCertificate -or $signed.SignerCertificate.Thumbprint -ne $cert.Thumbprint) {
    throw 'The installer was not signed with the generated certificate.'
  }

  # Never add a trust root: Windows can prompt interactively, including on CI.
  # Verify the embedded Authenticode signature and file hash with no UI.
  # The only acceptable trust failure is CERT_E_UNTRUSTEDROOT, expected for a
  # self-signed certificate. A hash mismatch or other failure is rejected.
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class RunContainerSignatureCheck {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct FileInfo {
    public uint cbStruct;
    public IntPtr path, file, knownSubject;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct TrustData {
    public uint cbStruct;
    public IntPtr policyCallback, sipClientData;
    public uint uiChoice, revocationChecks, unionChoice;
    public IntPtr fileInfo;
    public uint stateAction;
    public IntPtr stateData, urlReference;
    public uint providerFlags, uiContext;
    public IntPtr signatureSettings;
  }
  [DllImport("wintrust.dll", ExactSpelling = true, PreserveSig = true)]
  static extern int WinVerifyTrust(IntPtr hwnd, ref Guid action, ref TrustData data);
  public static int Verify(string path) {
    IntPtr pathPtr = Marshal.StringToCoTaskMemUni(path);
    IntPtr infoPtr = Marshal.AllocCoTaskMem(Marshal.SizeOf(typeof(FileInfo)));
    try {
      var file = new FileInfo { cbStruct = (uint)Marshal.SizeOf(typeof(FileInfo)), path = pathPtr };
      Marshal.StructureToPtr(file, infoPtr, false);
      var data = new TrustData { cbStruct = (uint)Marshal.SizeOf(typeof(TrustData)), uiChoice = 2,
        revocationChecks = 0, unionChoice = 1, fileInfo = infoPtr, providerFlags = 0x1010 };
      var action = new Guid("00AAC56B-CD44-11D0-8CC2-00C04FC295EE");
      return WinVerifyTrust(new IntPtr(-1), ref action, ref data);
    } finally { Marshal.FreeCoTaskMem(infoPtr); Marshal.FreeCoTaskMem(pathPtr); }
  }
}
'@
  $verified = Get-AuthenticodeSignature -LiteralPath $installer.FullName
  if (-not $verified.SignerCertificate -or $verified.SignerCertificate.Thumbprint -ne $cert.Thumbprint) {
    throw 'Signature signer did not match the generated certificate.'
  }
  $trustCode = [RunContainerSignatureCheck]::Verify($installer.FullName)
  if ($trustCode -ne 0 -and $trustCode -ne -2146762487) {
    throw ('Authenticode verification failed: 0x{0:X8}' -f [uint32]([long]$trustCode -band 0xffffffffL))
  }
  Write-Output "Self-signed $($installer.Name); Windows signature status: $($verified.Status). The certificate is not publicly trusted."
} finally {
  if ($cert) { Remove-Item -LiteralPath "Cert:\CurrentUser\My\$($cert.Thumbprint)" -DeleteKey -ErrorAction Stop }
}
