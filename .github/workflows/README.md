# GitHub Actions Release Workflow

This workflow automatically builds ZITEXT Editor for macOS, Windows, and Linux, then uploads the binaries to Cloudflare R2.

## Features

✅ **Multi-platform builds:**
- macOS (Intel x64 + Apple Silicon arm64)
- Windows (x64)
- Linux (x64 AppImage + .deb)

✅ **Code signing:**
- macOS: Full code signing and notarization (required — build fails without secrets)
- Windows: Code signing via Authenticode (required for removing SmartScreen warnings; configure secrets below)
- Linux: Detached GPG signatures (required)

✅ **SHA256 checksums:**
- A `.sha256` sidecar is generated alongside every installer
- Checksums are uploaded to R2 and included in GitHub artifacts
- Users can verify downloads with: `shasum -a 256 --check ZITEXT-x.y.z-platform.dmg.sha256`

✅ **Automated deployment:**
- Uploads all binaries and checksums to Cloudflare R2 bucket
- Organizes files in version folders (e.g., `v1.1.0/`)
- Sets public-read permissions for downloads

## How to trigger

Production releases originate only from immutable version tags. The tag must
match `package.json`, `package-lock.json`, `Cargo.toml`, and `tauri.conf.json`.

```bash
git tag v1.1.0
git push origin v1.1.0
```

## Required GitHub Secrets

Make sure all these secrets are configured in your repository:

### Apple Signing & Notarization
- `APPLE_CERTIFICATE` - Base64-encoded .p12 certificate
- `APPLE_CERTIFICATE_PASSWORD` - Password for .p12 file
- `APPLE_ID` - Your Apple ID email
- `APPLE_TEAM_ID` - 10-character team ID
- `APPLE_APP_SPECIFIC_PASSWORD` - App-specific password for notarization

### Windows signing
- `WINDOWS_CERTIFICATE` - Base64-encoded .pfx certificate
- `WINDOWS_CERTIFICATE_PASSWORD` - Password for .pfx file

### Linux signing
- `GPG_PRIVATE_KEY` - Armored private key used for detached signatures
- `GPG_PASSPHRASE` - Private-key passphrase

### Cloudflare R2
- `R2_ACCOUNT_ID` - Cloudflare account ID
- `R2_ACCESS_KEY_ID` - R2 API access key ID
- `R2_SECRET_ACCESS_KEY` - R2 API secret access key
- `R2_BUCKET_NAME` - R2 bucket name (e.g., `zitext-downloads`)

## Output Files

After successful build, files will be uploaded to R2 in this structure:

```
r2://your-bucket/v1.1.0/
├── ZITEXT-1.1.0-macOS-arm64.dmg
├── ZITEXT-1.1.0-macOS-arm64.dmg.sha256
├── ZITEXT-1.1.0-macOS-x64.dmg
├── ZITEXT-1.1.0-macOS-x64.dmg.sha256
├── ZITEXT-1.1.0-Windows-x64.msi
├── ZITEXT-1.1.0-Windows-x64.msi.sha256
├── ZITEXT-1.1.0-Windows-x64.exe
├── ZITEXT-1.1.0-Windows-x64.exe.sha256
├── ZITEXT-1.1.0-Linux-x64.AppImage
├── ZITEXT-1.1.0-Linux-x64.AppImage.sha256
├── ZITEXT-1.1.0-Linux-x64.AppImage.asc
├── ZITEXT-1.1.0-Linux-amd64.deb
├── ZITEXT-1.1.0-Linux-amd64.deb.sha256
└── ZITEXT-1.1.0-Linux-amd64.deb.asc
```

## Build Time

Typical build times:
- macOS: ~15-20 minutes (includes notarization wait time)
- Windows: ~10-15 minutes
- Linux: ~10-15 minutes

Total workflow time: ~20-25 minutes

## Troubleshooting

### macOS Notarization Fails
- Verify all Apple secrets are correct
- Check Apple Developer account is active and paid
- Review notarization logs in workflow output

### Windows Build Fails
- Verify both certificate secrets and inspect the Authenticode verification output

### R2 Upload Fails
- Verify R2 credentials are correct
- Check R2 bucket exists and is accessible
- Ensure R2 API token has "Object Read & Write" permissions

## Next Steps

After successful build:
1. Check R2 bucket to verify files are uploaded
2. Test download URLs: `https://pub-xxxxx.r2.dev/v1.1.0/ZITEXT-1.1.0-macOS-arm64.dmg`
3. Update website download links to point to new version
4. Test installation on each platform
