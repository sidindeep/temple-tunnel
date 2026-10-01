# Network protection lifecycle

Last verified: 2026-09-22.

## Invariants

- A healthy running tunnel keeps the WFP permission for its exact active TUN
  interface until that tunnel is replaced or stopped.
- Changing only automatic/manual server selection does not rebuild the tunnel
  or replace WFP filters.
- `session` protection is active while connecting, connected, recovering, or
  failed after an attempted protected connection. A normal manual disconnect or
  normal application exit clears it, including when encrypted logging is unavailable.
- `always` protection remains active after disconnect and normal exit. Changing
  `always` to `session` while disconnected clears the persistent filters.
- A manual disconnect supersedes reconnection started by a core update, a
  delayed settings or subscription save, and delayed application/routing edits.
  A late continuation cannot reconnect the VPN after that command.
- Deleting the final active subscription is an intentional disconnect: it
  clears `session` protection and retains `always` protection. A cleanup error
  is reported without claiming the firewall was cleared.
- Application routing and WFP use the exact executable path when the user chose
  an EXE file or a running process whose path Windows can resolve. The process
  picker verifies PID and name again when selected, including service EXE paths.
  Name-only matching remains available only without Kill switch. On startup,
  active name-only entries are upgraded to exact paths when the process is
  running and Windows exposes its executable or service command.
  Two executables with the same filename but different paths remain distinct.

## Verification

0.14.4: перед созданием Windows TUN `src/windows-ipv6.js` читает DWORD
`HKLM/SYSTEM/CurrentControlSet/Services/Tcpip6/Parameters/DisabledComponents`
без изменения системы. Значение переводится из signed DWORD в UInt32; бит
`0x10` отключает назначение IPv6 TUN, DNS использует `ipv4_only`. Биты переходных
туннелей (`0x01`) и предпочтения IPv4 (`0x20`) отдельно не меняют адреса TUN.
Отсутствующее значение означает 0; ошибка/тайм-аут/неверный тип сохраняет IPv6.
После асинхронного чтения проверяется поколение подключения. `strict_route`
всегда сохраняется: sing-tun v0.8.14, используемый sing-box 1.13.20, при отсутствии
IPv6-адреса устанавливает WFP `block ipv6` (кроме разрешённого процесса ядра).
Источник: https://github.com/SagerNet/sing-tun/blob/v0.8.14/tun_windows.go.
Покрытие: `test/windows-ipv6.test.js`, `test/singbox.test.js`,
`test/connection-lifecycle.test.js`. Реальные пакеты и запуск на ПК с отключённым
IPv6 требуют отдельной проверки; реестр рабочей машины для теста не изменяется.

- `test/connection-lifecycle.test.js` covers policy-only changes, protection
  transitions, shutdown without a file logger, update cancellation, delayed
  saves, and deletion of the final subscription.
- `test/singbox.test.js` covers exact-path routing and name-only fallback; the
  generated exact-path configuration passes the bundled sing-box validator.
- `test/security-settings.test.js` covers WFP arguments, serialization, and
  error mapping.
- Real packet behavior still requires an elevated Windows test with IPv4, IPv6,
  DNS, process-path collisions, core failure, sleep/resume, and application exit.
