# Android packaging

The Android client is a standalone Gradle project under `android/`. It requires
JDK 17 and Android SDK 35.

## Debug APK

```powershell
cd android
$env:JAVA_HOME = "C:\path\to\jdk-17"
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
.\gradlew.bat testDebugUnitTest assembleDebug
```

Output: `android/app/build/outputs/apk/debug/app-debug.apk`.

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

Output: `android/app/build/outputs/apk/release/app-release.apk`.

The same keystore must sign every later update with application id
`local.templetunnel.android`. Losing it prevents updates over an installed copy.
