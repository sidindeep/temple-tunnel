package local.templetunnel.android.vpn

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Network
import android.net.LinkProperties
import android.net.VpnService
import android.os.Build
import android.os.ParcelFileDescriptor
import android.os.Process
import android.system.OsConstants
import androidx.core.app.NotificationCompat
import io.nekohasekai.libbox.*
import local.templetunnel.android.MainActivity
import local.templetunnel.android.R
import local.templetunnel.android.TempleApplication
import java.net.InetSocketAddress
import java.net.Socket
import java.net.NetworkInterface as JavaNetworkInterface
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory
import java.security.KeyStore
import java.security.cert.X509Certificate
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicBoolean
import android.util.Base64

class TempleVpnService : VpnService(), PlatformInterface, CommandServerHandler {
    companion object {
        const val ACTION_CONNECT = "local.templetunnel.CONNECT"
        const val ACTION_DISCONNECT = "local.templetunnel.DISCONNECT"
        const val ACTION_RECONNECT = "local.templetunnel.RECONNECT"
        private const val CHANNEL = "temple-vpn"
        private const val NOTIFICATION_ID = 41
    }

    @Volatile private var commandServer: CommandServer? = null
    @Volatile private var tun: ParcelFileDescriptor? = null
    private var monitor: InterfaceUpdateListener? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    private val operation = AtomicInteger()
    private val recoveryPending = AtomicBoolean()
    private val coreLock = Any()
    @Volatile private var activeHealthPort = 0

    override fun onCreate() {
        super.onCreate()
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_DISCONNECT) {
            stopTunnel(); return START_NOT_STICKY
        }
        if (intent?.action != ACTION_RECONNECT && VpnState.status.value.phase in setOf(ConnectionPhase.CONNECTING, ConnectionPhase.CONNECTED)) return START_STICKY
        val ticket = operation.incrementAndGet()
        startForeground(NOTIFICATION_ID, notification("Подключение…"))
        VpnState.status.value = ConnectionStatus(ConnectionPhase.CONNECTING, "Подключение…")
        DiagnosticLog.record("Подключение запрошено")
        Thread { runCatching { startTunnel(ticket) }.onFailure { if (ticket == operation.get()) fail(it) } }.start()
        return START_STICKY
    }

    private fun startTunnel(ticket: Int) {
        stopCore()
        requireActive(ticket)
        val repository = (application as TempleApplication).repository
        val snapshot = repository.load()
        val subscription = snapshot.subscriptions.firstOrNull { it.id == snapshot.settings.activeSubscriptionId }
            ?: snapshot.subscriptions.firstOrNull() ?: error("Сначала добавьте подписку")
        val selected = subscription.servers.firstOrNull { it.id == snapshot.settings.selectedServerId }
        val candidates = if (snapshot.settings.automaticServer) {
            listOfNotNull(selected) + subscription.servers.filterNot { it.id == selected?.id }
                .sortedWith(compareBy({ it.latencyMs == null }, { it.latencyMs ?: Long.MAX_VALUE }))
        } else listOfNotNull(selected ?: subscription.servers.firstOrNull())
        require(candidates.isNotEmpty()) { "В подписке нет серверов" }
        val rulesDir = java.io.File(filesDir, "rules").apply { mkdirs() }
        val geoIp = copyAsset("geoip-ru.srs", rulesDir)
        val geoSite = copyAsset("geosite-category-ru.srs", rulesDir)
        var lastFailure: Throwable? = null
        for ((index, server) in candidates.take(3).withIndex()) {
            requireActive(ticket)
            if (index > 0) DiagnosticLog.record("Проверка резервного сервера ${index + 1}")
            try {
                val healthPort = Libbox.availablePort(12_000)
                val config = SingBoxConfigBuilder.build(server, snapshot.settings, geoIp.absolutePath, geoSite.absolutePath, healthPort)
                Libbox.checkConfig(config)
                requireActive(ticket)
                val created = Libbox.newCommandServer(this, this)
                synchronized(coreLock) {
                    requireActive(ticket)
                    commandServer = created
                }
                created.startWithTemporaryPort()
                created.startOrReloadService(config, null)
                requireActive(ticket)
                verifyTunnel(healthPort)
                requireActive(ticket)
                activeHealthPort = healthPort
                if (snapshot.settings.automaticServer && server.id != snapshot.settings.selectedServerId) {
                    val latest = repository.load()
                    if (latest.settings.automaticServer && latest.settings.activeSubscriptionId == subscription.id) {
                        repository.save(latest.copy(settings = latest.settings.copy(selectedServerId = server.id)))
                    }
                }
                VpnState.status.value = ConnectionStatus(ConnectionPhase.CONNECTED, "Подключено: ${server.name}")
                DiagnosticLog.record("Защищённое соединение подтверждено")
                updateNotification("Подключено: ${server.name}")
                return
            } catch (error: Throwable) {
                requireActive(ticket)
                lastFailure = error
                DiagnosticLog.record("Проверка кандидата завершилась ошибкой: ${error.javaClass.simpleName}")
                stopCore()
            }
        }
        throw IllegalStateException("Не удалось подключиться ни к одному из проверенных серверов", lastFailure)
    }

    private fun requireActive(ticket: Int) { check(ticket == operation.get()) { "Подключение отменено" } }

    private fun verifyTunnel(port: Int) {
        val host = "www.cloudflare.com"
        try {
            Socket().use { proxy ->
                proxy.connect(InetSocketAddress("127.0.0.1", port), 8_000)
                proxy.soTimeout = 8_000
                val input = proxy.getInputStream()
                val output = proxy.getOutputStream()
                output.write(byteArrayOf(5, 1, 0)); output.flush()
                val greeting = ByteArray(2)
                readFully(input, greeting)
                check(greeting.contentEquals(byteArrayOf(5, 0))) { "Локальный SOCKS-прокси недоступен" }
                val domain = host.toByteArray(Charsets.US_ASCII)
                output.write(byteArrayOf(5, 1, 0, 3, domain.size.toByte()))
                output.write(domain); output.write(byteArrayOf(1, 187.toByte())); output.flush()
                val reply = ByteArray(4)
                readFully(input, reply)
                check(reply[0] == 5.toByte() && reply[1] == 0.toByte()) { "VPN-сервер отклонил проверочное соединение" }
                val addressBytes = when (reply[3].toInt() and 0xff) {
                    1 -> 4
                    3 -> input.read().also { check(it in 0..255) }
                    4 -> 16
                    else -> error("Некорректный ответ SOCKS-прокси")
                }
                readFully(input, ByteArray(addressBytes + 2))
                ((SSLSocketFactory.getDefault() as SSLSocketFactory).createSocket(proxy, host, 443, false) as SSLSocket).use { tls ->
                    tls.soTimeout = 8_000
                    tls.sslParameters = tls.sslParameters.apply { endpointIdentificationAlgorithm = "HTTPS" }
                    tls.startHandshake()
                    tls.outputStream.write("GET /cdn-cgi/trace HTTP/1.1\r\nHost: $host\r\nUser-Agent: TempleTunnel/0.14.1 Android\r\nConnection: close\r\n\r\n".toByteArray(Charsets.US_ASCII))
                    tls.outputStream.flush()
                    val response = ByteArray(32 * 1024)
                    val count = tls.inputStream.read(response)
                    check(count > 0 && String(response, 0, count, Charsets.US_ASCII).startsWith("HTTP/1.1 200")) {
                        "Проверочный HTTPS-запрос не прошёл через VPN"
                    }
                }
            }
        } catch (error: Throwable) {
            throw IllegalStateException("VPN-сервер не подтвердил защищённое соединение", error)
        }
    }

    private fun readFully(input: java.io.InputStream, bytes: ByteArray) {
        var offset = 0
        while (offset < bytes.size) {
            val count = input.read(bytes, offset, bytes.size - offset)
            check(count > 0) { "Соединение прервано" }
            offset += count
        }
    }

    private fun copyAsset(name: String, directory: java.io.File): java.io.File {
        val target = java.io.File(directory, name)
        if (!target.exists()) assets.open(name).use { input -> target.outputStream().use(input::copyTo) }
        return target
    }

    private fun stopTunnel() {
        operation.incrementAndGet()
        VpnState.status.value = ConnectionStatus(ConnectionPhase.STOPPING, "Отключение…")
        DiagnosticLog.record("Ручное отключение")
        Thread {
            stopCore()
            VpnState.status.value = ConnectionStatus()
            stopForeground(STOP_FOREGROUND_REMOVE); stopSelf()
        }.start()
    }
    private fun stopCore() {
        activeHealthPort = 0
        val (server, descriptor) = synchronized(coreLock) {
            val old = commandServer to tun
            commandServer = null; tun = null
            old
        }
        runCatching { server?.closeService() }; runCatching { server?.close() }
        runCatching { descriptor?.close() }
    }
    private fun fail(error: Throwable) {
        stopCore(); val message = error.message ?: "Не удалось запустить VPN"
        DiagnosticLog.record("Подключение не удалось: ${error.javaClass.simpleName}")
        VpnState.status.value = ConnectionStatus(ConnectionPhase.ERROR, message)
        updateNotification("Ошибка: $message")
    }
    override fun onDestroy() { operation.incrementAndGet(); stopCore(); super.onDestroy() }
    override fun onRevoke() { stopTunnel() }

    override fun openTun(options: TunOptions): Int {
        if (prepare(this) != null) error("Нет разрешения Android на VPN")
        val builder = Builder().setSession("Temple Tunnel").setMtu(options.mtu)
        if (Build.VERSION.SDK_INT >= 29) builder.setMetered(false)
        options.inet4Address.addAddresses(builder)
        options.inet6Address.addAddresses(builder)
        if (options.autoRoute) {
            options.dnsServerAddress.value.takeIf { it.isNotBlank() }?.let(builder::addDnsServer)
            options.inet4RouteRange.addRoutes(builder)
            options.inet6RouteRange.addRoutes(builder)
            options.includePackage.addPackages { builder.addAllowedApplication(it) }
            options.excludePackage.addPackages { builder.addDisallowedApplication(it) }
        }
        val descriptor = builder.establish() ?: error("Android отозвал разрешение VPN")
        synchronized(coreLock) { tun = descriptor }
        return descriptor.fd
    }

    override fun autoDetectInterfaceControl(fd: Int) { protect(fd) }
    override fun usePlatformAutoDetectInterfaceControl() = true
    override fun useProcFS() = Build.VERSION.SDK_INT < 29
    override fun underNetworkExtension() = false
    override fun includeAllNetworks() = false
    override fun clearDNSCache() = Unit
    override fun localDNSTransport(): LocalDNSTransport? = null
    override fun readWIFIState() = WIFIState("", "")
    override fun sendNotification(notification: io.nekohasekai.libbox.Notification) = Unit

    override fun startDefaultInterfaceMonitor(listener: InterfaceUpdateListener) {
        monitor = listener
        val cm = getSystemService(ConnectivityManager::class.java)
        networkCallback?.let { runCatching { cm.unregisterNetworkCallback(it) } }
        networkCallback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) { updateDefaultInterface(listener); scheduleRecoveryCheck() }
            override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) { updateDefaultInterface(listener); scheduleRecoveryCheck() }
            override fun onLinkPropertiesChanged(network: Network, linkProperties: LinkProperties) { updateDefaultInterface(listener); scheduleRecoveryCheck() }
            override fun onLost(network: Network) { updateDefaultInterface(listener); scheduleRecoveryCheck() }
        }.also(cm::registerDefaultNetworkCallback)
        updateDefaultInterface(listener)
    }

    private fun scheduleRecoveryCheck() {
        if (VpnState.status.value.phase != ConnectionPhase.CONNECTED || !recoveryPending.compareAndSet(false, true)) return
        val ticket = operation.get()
        Thread {
            try {
                Thread.sleep(1_500)
                if (ticket != operation.get() || VpnState.status.value.phase != ConnectionPhase.CONNECTED) return@Thread
                runCatching { commandServer?.resetNetwork() }
                val port = activeHealthPort
                if (port == 0) return@Thread
                try { verifyTunnel(port) } catch (_: Throwable) {
                    if (ticket != operation.get()) return@Thread
                    DiagnosticLog.record("Сеть изменилась; начинаем восстановление")
                    val next = operation.incrementAndGet()
                    VpnState.status.value = ConnectionStatus(ConnectionPhase.CONNECTING, "Восстановление соединения…")
                    updateNotification("Восстановление соединения…")
                    runCatching { startTunnel(next) }.onFailure { if (next == operation.get()) fail(it) }
                }
            } finally { recoveryPending.set(false) }
        }.start()
    }
    override fun closeDefaultInterfaceMonitor(listener: InterfaceUpdateListener) {
        if (monitor === listener) monitor = null
        networkCallback?.let { runCatching { getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(it) } }
        networkCallback = null
    }
    private fun updateDefaultInterface(listener: InterfaceUpdateListener) {
        val cm = getSystemService(ConnectivityManager::class.java)
        val network = cm.activeNetwork?.takeUnless { cm.getNetworkCapabilities(it)?.hasTransport(NetworkCapabilities.TRANSPORT_VPN) == true }
            ?: cm.allNetworks.firstOrNull { candidate ->
                val capabilities = cm.getNetworkCapabilities(candidate)
                capabilities?.hasTransport(NetworkCapabilities.TRANSPORT_VPN) == false &&
                    capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            } ?: return
        val link = cm.getLinkProperties(network) ?: return
        val capabilities = cm.getNetworkCapabilities(network)
        listener.updateDefaultInterface(link.interfaceName.orEmpty(), JavaNetworkInterface.getByName(link.interfaceName)?.index ?: 0,
            capabilities?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true,
            capabilities?.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) != true)
    }
    override fun getInterfaces(): NetworkInterfaceIterator {
        val cm = getSystemService(ConnectivityManager::class.java)
        val values = cm.allNetworks.mapNotNull { network ->
            val link = cm.getLinkProperties(network) ?: return@mapNotNull null
            val native = JavaNetworkInterface.getByName(link.interfaceName) ?: return@mapNotNull null
            val capabilities = cm.getNetworkCapabilities(network)
            if (capabilities?.hasTransport(NetworkCapabilities.TRANSPORT_VPN) == true) return@mapNotNull null
            NetworkInterface().apply {
                name = native.name; index = native.index; mtu = runCatching { native.mtu }.getOrDefault(1500)
                addresses = Strings(native.interfaceAddresses.map { "${it.address.hostAddress}/${it.networkPrefixLength}" })
                dnsServer = Strings(link.dnsServers.mapNotNull { it.hostAddress })
                type = when {
                    capabilities?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true -> Libbox.InterfaceTypeWIFI
                    capabilities?.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) == true -> Libbox.InterfaceTypeCellular
                    capabilities?.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) == true -> Libbox.InterfaceTypeEthernet
                    else -> Libbox.InterfaceTypeOther
                }
                flags = (if (capabilities?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true) OsConstants.IFF_UP or OsConstants.IFF_RUNNING else 0) or
                    (if (native.isLoopback) OsConstants.IFF_LOOPBACK else 0) or
                    (if (native.isPointToPoint) OsConstants.IFF_POINTOPOINT else 0) or
                    (if (native.supportsMulticast()) OsConstants.IFF_MULTICAST else 0)
                metered = capabilities?.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) != true
            }
        }
        return Interfaces(values)
    }
    override fun findConnectionOwner(protocol: Int, sourceAddress: String, sourcePort: Int, destinationAddress: String, destinationPort: Int): ConnectionOwner {
        if (Build.VERSION.SDK_INT < 29) error("Определение приложения требует Android 10+")
        val uid = getSystemService(ConnectivityManager::class.java).getConnectionOwnerUid(protocol,
            InetSocketAddress(sourceAddress, sourcePort), InetSocketAddress(destinationAddress, destinationPort))
        if (uid == Process.INVALID_UID) error("Приложение для соединения не найдено")
        return ConnectionOwner().apply {
            userId = uid; userName = packageManager.getPackagesForUid(uid)?.firstOrNull().orEmpty()
            androidPackageName = userName
        }
    }
    override fun systemCertificates(): StringIterator {
        val store = KeyStore.getInstance("AndroidCAStore").apply { load(null) }
        val values = store.aliases().toList().mapNotNull { alias -> store.getCertificate(alias) as? X509Certificate }.map { certificate ->
            val encoded = Base64.encodeToString(certificate.encoded, Base64.NO_WRAP).chunked(64).joinToString("\n")
            "-----BEGIN CERTIFICATE-----\n$encoded\n-----END CERTIFICATE-----"
        }
        return Strings(values)
    }

    override fun getSystemProxyStatus() = SystemProxyStatus()
    override fun serviceReload() = Unit
    override fun serviceStop() { stopTunnel() }
    override fun setSystemProxyEnabled(enabled: Boolean) = Unit
    override fun writeDebugMessage(message: String?) = Unit

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= 26) getSystemService(NotificationManager::class.java)
            .createNotificationChannel(NotificationChannel(CHANNEL, "VPN", NotificationManager.IMPORTANCE_LOW))
    }
    private fun notification(text: String) = NotificationCompat.Builder(this, CHANNEL)
        .setSmallIcon(android.R.drawable.stat_sys_warning).setContentTitle("Temple Tunnel").setContentText(text).setOngoing(true)
        .setContentIntent(PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
        .addAction(0, "Отключить", PendingIntent.getService(this, 1, Intent(this, TempleVpnService::class.java).setAction(ACTION_DISCONNECT), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
        .build()
    private fun updateNotification(text: String) { getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification(text)) }
}

private class Strings(private val values: List<String>) : StringIterator {
    private var index = 0
    override fun hasNext() = index < values.size
    override fun len() = values.size
    override fun next() = values[index++]
}
private class Interfaces(private val values: List<NetworkInterface>) : NetworkInterfaceIterator {
    private var index = 0
    override fun hasNext() = index < values.size
    override fun next() = values[index++]
}
private fun RoutePrefixIterator.addAddresses(builder: VpnService.Builder) { while (hasNext()) next().also { builder.addAddress(it.address(), it.prefix()) } }
private fun RoutePrefixIterator.addRoutes(builder: VpnService.Builder) { while (hasNext()) next().also { builder.addRoute(it.address(), it.prefix()) } }
private fun StringIterator.addPackages(block: (String) -> Unit) { while (hasNext()) block(next()) }
