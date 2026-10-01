# Android client contract

Last updated: 2026-09-23.

## Product boundary

The Android client is a standalone Kotlin/Compose application under `android/`.
It shares product behavior with the Windows client but does not reuse Electron,
Windows safeStorage, WFP, executable paths, or Windows process matching.

## Connection lifecycle

1. The user imports an HTTPS subscription or a supported single key.
2. The source and parsed profiles are stored with Android Keystore backed
   encrypted preferences.
3. The client requests system VPN consent before starting `TempleVpnService`.
4. The service copies bundled RU rule sets to its private directory, validates
   the generated configuration with libbox, starts the TUN service, and checks
   HTTPS connectivity through a local SOCKS inbound routed through the selected
   outbound.
5. The UI reports connected only after the protected check succeeds. A failed
   check closes the core and TUN descriptor and reports an error.
6. Manual disconnect closes the libbox service and TUN descriptor, removes the
   foreground notification, and wins over automatic Android service restart.
7. A network change triggers a protected HTTPS recheck; a failed recheck
   restarts the tunnel. Automatic selection may try up to two backup servers.

## Routing invariants

- `FULL` establishes a VPN for all applications.
- `SELECTED` requires at least one package and passes it to the TUN inbound as
  `include_package`.
- `BYPASS` passes selected packages as `exclude_package`; all other applications
  use the VPN.
- Split modes route the bundled Russian rule sets directly. Full mode does so
  only when the user explicitly disables Russian sites through VPN.
- IPv6 is captured by the TUN and rejected when disabled; it must never leak
  outside the VPN as an accidental fallback.
- Android Always-on VPN and “block connections without VPN” provide the kill
  switch. The app does not emulate the Windows WFP implementation.

## Supported profile contract

VLESS supports TCP, gRPC, WebSocket, HTTPUpgrade, HTTP/2, TLS and REALITY.
Hysteria 2 supports TLS and optional salamander obfuscation. XHTTP imports are
preserved but connection is rejected until the embedded libbox build is verified
with `with_xhttp`.

## Verification

- JVM tests cover VLESS validation, Android package filters, RU routing, IPv6
  blocking, and the explicit XHTTP guard.
- Gradle builds and APK signature verification cover packaging integrity.
- Android 15 emulator instrumentation calls native `Libbox.checkConfig` for
  VLESS REALITY in full and package-filtered modes, plus Hysteria 2 in full mode.
- Import/refresh run off the UI thread, and a failed encrypted-preference read
  is reported rather than silently replacing user data.
- The in-memory diagnostic log stores only predefined event messages and can
  be exported by the user.
- No successful live VPN session has been demonstrated without a valid profile.
- A release decision still requires a physical-device matrix for Android 7,
  10, 13, and 15+, Wi-Fi/mobile switching, sleep/resume, Always-on, DNS/IPv6,
  each supported transport, and vendor battery restrictions.
