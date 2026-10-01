# Android packaging

The Android client is a standalone Gradle project under `android/`. It requires
JDK 17 and Android SDK 35.

## Debug APK

```powershell
cd android
$env:JAVA_HOME = "C:\path\to\jdk-17"
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
.\gradlew.bat testDebugUnitTest lintDebug assembleDebug
```

Gradle output: `android/app/build/outputs/apk/debug/app-debug.apk`. From the
project root, copy a build selected for distribution to `artifacts/android/`:

```powershell
New-Item -ItemType Directory -Force artifacts/android | Out-Null
Copy-Item android/app/build/outputs/apk/debug/app-debug.apk artifacts/android/
```
With an Android emulator or device connected, run `connectedDebugAndroidTest` to
validate generated configurations against the embedded native libbox build.

## Signed release APK

Keep the keystore and passwords outside Git. Set these environment variables:

```powershell
$env:TEMPLE_ANDROID_KEYSTORE = "C:\secure\temple-tunnel-release.jks"
$env:TEMPLE_ANDROID_STORE_PASSWORD = "..."
$env:TEMPLE_ANDROID_KEY_ALIAS = "temple-tunnel"
$env:TEMPLE_ANDROID_KEY_PASSWORD = "..."
cd android
.\gradlew.bat testDebugUnitTest assembleRelease
```

Gradle output: `android/app/build/outputs/apk/release/app-release.apk`. From the
project root, copy the verified release APK to `artifacts/android/`:

```powershell
New-Item -ItemType Directory -Force artifacts/android | Out-Null
Copy-Item android/app/build/outputs/apk/release/app-release.apk artifacts/android/
```
Verify the signed file with Android SDK `apksigner verify --verbose` before
distribution. A successful build and emulator launch do not replace a live VPN
test with a valid profile on a physical device.

The same keystore must sign every later update with application id
`local.templetunnel.android`. Losing it prevents updates over an installed copy.
