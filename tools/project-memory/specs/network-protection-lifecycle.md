# Network protection lifecycle

Last verified: 2026-10-14 (source and automated checks; live coexistence pending).

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

## Исправление совместной работы VPN — 2026-10-14

Карта механизма до изменения: включение другого VPN → Windows добавляет
интерфейс/маршруты/DNS → `main.js:pollNetwork` без проверки останавливает TUN;
владелец восстановления — `main.js`, проверка — lifecycle-тесты сохранения
здорового ядра и отмены устаревшей проверки. Исключение EXE → правила
`singbox.js:buildConfig` применяются после IPv6/DNS и не влияют на WFP
`strict_route`; владелец порядка и политики TUN — builder, проверка —
регрессии правил и настоящий bundled `check`/запуск без TUN.
Выход ядра → общая auto-detect привязка может выбрать другой VPN;
владелец снимка физического выхода — `windows-dns.js`, потребители — builder,
пул и Xray; проверки — синтетические адаптеры, конфигурации и startup harness.

Граница проверки: интеграция с настоящим Kerio, Windows TUN/WFP и личным
рабочим соединением требует отдельного запуска с правами администратора.
Тесты конфигурации и mock lifecycle её не заменяют.

Контракт 0.14.10:

- Изменение сетевой топологии не останавливает здоровый TUN. После 2 секунд
  стабильной топологии проверяется текущий защищённый выход; только неудачи,
  подтверждённые за 10 секунд, запускают существующее восстановление. Проверка
  делит mutex с обычным health monitor и игнорирует результаты после смены
  ядра, операции, сервера, топологии, ручного отключения, сна или offline.
  Изменения во время подключения не прерывают его итоговую проверку.
- В `bypass` конечное EXE-исключение для `tun-in` стоит перед IPv6 reject,
  sniff, hijack DNS и пользовательскими VPN/блокирующими правилами. DNS к
  собственному peer TUN остаётся локальным hijack; иной DNS исключённого EXE
  сохраняет исходное назначение. Health inbounds сохраняют маршрут proxy.
- `strict_route` включён в `full`. В раздельных режимах он выключен, кроме
  IPv4-only TUN с неизвестным DisabledComponents или возможными переходными
  IPv6-интерфейсами. Подтверждённые биты `0x11` позволяют выключить его и без
  IPv6 TUN; обычная политика блокировки IPv6 сохраняет перехват/отказ для
  защищённого трафика. Глобальная защита DNS от multihomed-запросов в split
  без Kill switch намеренно уступает совместимости с DNS другого VPN.
- Снимок до запуска ядер выбирает физический подключённый интерфейс с IPv4
  default route, ранжируя его по метрике маршрута+интерфейса. DNS берётся с
  этого же интерфейса; при его отсутствии — 1.1.1.1. Virtual/TUN с меньшей
  метрикой не заменяет найденный физический выход. При ошибке обнаружения
  остаётся auto_detect_interface; источник/наличие привязки логируются без имён
  адаптеров/адресов. Windows-настройки не записываются.
- `bind_interface` применяется к удалённым native proxy, каждому члену пула,
  direct fallback и direct DNS. Loopback SOCKS bridge не привязывается к
  физическому NIC. Xray получает `sockopt.interface` для удалённых соединений,
  включая отдельный XHTTP downloadSettings, без изменения импортированного
  объекта. Более конкретные корпоративные Windows-маршруты обходят /0 TUN
  нативно; они не переписываются и не привязываются к физическому direct.
- Kill switch не расширяет разрешения общей службы DNS Windows; корпоративный
  DNS при нём, два VPN с принудительными полными маршрутами и частичное
  отключение IPv6 `0x10` остаются отдельными интеграционными ограничениями.
- Локальные mixed/SOCKS/DNS порты выбираются единым `src/loopback-port.js`:
  временно проверяются TCP и UDP на одном номере, ресурсы закрываются; при
  EACCES/EADDRINUSE до 20 попыток чередуют TCP и UDP ephemeral allocator,
  поскольку Windows резервирует разные диапазоны. API/TCP-only порты не
  требуют UDP. Окончательный bind всё ещё может проиграть гонку после снимка;
  startup error не скрывается. Потребители — main/probe и real-core fixtures.

Регрессии: `test/connection-lifecycle.test.js`, `test/windows-dns.test.js`,
`test/singbox.test.js`, `test/xray.test.js`, `test/core-security-config.test.js`,
`test/tunnel-pool.test.js`, `test/xray-group.test.js`,
`test/loopback-port.test.js`, `test/excluded-traffic.test.js`.
Реальная проверка EXE через loopback mixed inbound подтверждает точный путь:
выбранный процесс обходит синтетический reject и получает TCP echo;
одноимённый EXE с другим путём получает reject без обращения к echo.
Источник Windows /0:
https://github.com/SagerNet/sing-tun/blob/v0.8.14/tun_rules.go;
WFP strict-route: https://github.com/SagerNet/sing-tun/blob/v0.8.14/tun_windows.go;
Xray NIC: https://github.com/XTLS/Xray-core/blob/v26.3.27/transport/internet/sockopt_windows.go.

## История проверок

0.14.9: в режиме `selected` с политикой DNS `routing` запросы, владельцем
которых ядро определило `svchost.exe`, направляются в `dns-proxy`. Windows DNS
Client выполняет запросы от общей службы, поэтому пути выбранных EXE для этих
запросов не совпадают. Правило добавлено после локальных, пользовательских,
российских доменных правил и правил приложений; доменные исключения сохраняют
приоритет. Соединения самого `svchost.exe` не добавляются в список VPN-приложений.
Запросы от других невыбранных процессов сохраняют `dns-direct`; в режимах
`full`/`bypass` и при политике `vpn` нового правила нет. DNS без распознанного
владельца этим правилом не охватывается. Общие DNS-запросы нельзя разделить по
исходным приложениям. Регрессии: `test/singbox.test.js`; валидация конфигурации
и старт ядра: `test/core-security-config.test.js`. Проверка работы Codex в
раздельном режиме на установленной 0.14.9 остаётся необходимой.

0.14.5: `src/windows-dns.js` до запуска TUN читает IPv4 маршруты по умолчанию,
состояние интерфейсов и их DNS. Выбирается подключённый интерфейс с минимальной
суммой метрик; `temple-tun*`, IPv6 и localhost исключены. При ошибке обнаружения
используется прежний публичный резерв 1.1.1.1. `main.js` всегда передаёт этот
снимок в `dns-direct` как UDP с прямым dialer по умолчанию, независимо от Kill switch.
После чтения проверяется актуальность операции подключения. `strict_route`
сохраняется; DNS правила доменов и приложений не меняются. Системные настройки
не записываются. Источник DNS отмечается в журнале без сетевых адресов.
Проверки: `test/windows-dns.test.js`, `test/connection-lifecycle.test.js`,
`test/singbox.test.js`, `test/core-security-config.test.js`. Живая диагностика
до исправления: прямой DNS через TUN не отвечал за 4 секунды; при ожидании
15 секунд ответ пришёл за 5,3 секунды, DNS health через VPN отвечал за 71 мс.
Проверка прямого DNS после обновления установленного клиента остаётся отдельной
проверкой; unit-тесты и валидатор ядра не подтверждают исправление на машине.

0.14.6: sing-box 1.13.20 отвергает UDP DNS `detour: direct`, если прямой
outbound не содержит дополнительных настроек: `detour to an empty direct
outbound makes no sense`. `check` при этом успешен. Параметр удалён; новый UDP
DNS использует прямое соединение по умолчанию. Регрессионный тест запускает
настоящее ядро без TUN/запросов/личных профилей и ждёт `sing-box started`.
Эта ошибка конфигурации DNS распознаётся до общей классификации `start service`
как ошибки TUN. Живая проверка после установки требуется отдельно.

Установщик 0.14.6: `build/installer.nsh` переопределяет NSIS
`customCheckAppRunning` до удаления старой версии/замены файлов. Проверяет образ
`${APP_EXECUTABLE_FILENAME}`, `build/close-app.ps1` отправляет WM_CLOSE через
`CloseMainWindow` и ожидает
до 10 секунд. Штатный выход выполняет существующий `before-quit`: остановка
ядер, очистка session-защиты/сохранение always-защиты, flush журнала. При
зависании завершает только заранее отслеженное дерево клиента,
без глобального завершения sing-box/xray. Идентичность процесса проверяется по
PID, имени и CreationDate перед остановкой, включая потомков после выхода
родителя. После принудительного завершения
разрешено продолжать только при nsProcess 603 (образ не найден); иные результаты
останавливают установку. Заголовок установщика требует administrator, сохраняя
выбор области установки. Аварийное завершение не гарантирует штатную очистку
WFP; фильтры проверяются при следующем запуске клиента.

Проверка закрытия: `test/installer-shutdown.test.js` запускает невидимое тестовое
окно без перехвата фокуса, отдельный процесс-ядро и посторонний процесс. Проверяет
штатный выход, зависание, выход родителя с оставшимся ядром и отсутствие клиента;
после проверки все тестовые процессы и файлы удаляются. Реальные пользовательские
подписки/настройки и другие программы для этого теста не используются.

0.14.7: NSIS `File /oname=temple-close-app.ps1` извлекал помощник в `$OUTDIR`,
но `nsExec` запускал `$PLUGINSDIR/temple-close-app.ps1`. Прямой тест PowerShell
это не обнаруживал. Теперь `/oname` содержит полный путь `$PLUGINSDIR` и не
изменяет `$OUTDIR`. `test/installer-shutdown.test.js` дополнительно компилирует
и выполняет настоящий `customCheckAppRunning`, проверяет закрытие приложения
с пробелами в имени, неизменный `$OUTDIR` и отсутствие помощника в папке
установки. Тест не устанавливает продукт и не обращается к пользовательским
подпискам. Старый хук завершался с кодом 1; исправленный хук проходит этот сценарий.

0.14.4: перед созданием Windows TUN `src/windows-ipv6.js` читает DWORD
`HKLM/SYSTEM/CurrentControlSet/Services/Tcpip6/Parameters/DisabledComponents`
без изменения системы. Значение переводится из signed DWORD в UInt32; бит
`0x10` отключает назначение IPv6 TUN, DNS использует `ipv4_only`. Биты переходных
туннелей (`0x01`) и предпочтения IPv4 (`0x20`) отдельно не меняют адреса TUN.
Отсутствующее значение означает 0; ошибка/тайм-аут/неверный тип сохраняет IPv6.
После асинхронного чтения проверяется поколение подключения. До 0.14.10 `strict_route`
всегда сохранялся: sing-tun v0.8.14, используемый sing-box 1.13.20, при отсутствии
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
