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
import java.net.NetworkInterface as JavaNetworkInterface
import java.security.KeyStore
import java.security.cert.X509Certificate
import android.util.Base64

class TempleVpnService : VpnService(), PlatformInterface, CommandServerHandler {
    companion object {
        const val ACTION_CONNECT = "local.templetunnel.CONNECT"
        const val ACTION_DISCONNECT = "local.templetunnel.DISCONNECT"
        private const val CHANNEL = "temple-vpn"
        private const val NOTIFICATION_ID = 41
    }

    private var commandServer: CommandServer? = null
    private var tun: ParcelFileDescriptor? = null
    private var monitor: InterfaceUpdateListener? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_DISCONNECT) {
            stopTunnel(); return START_NOT_STICKY
        }
        startForeground(NOTIFICATION_ID, notification("Подключение…"))
        VpnState.status.value = ConnectionStatus(ConnectionPhase.CONNECTING, "Подключение…")
        Thread { runCatching { startTunnel() }.onFailure(::fail) }.start()
        return START_STICKY
    }

    private fun startTunnel() {
        stopCore()
        val repository = (application as TempleApplication).repository
        val snapshot = repository.load()
        val subscription = snapshot.subscriptions.firstOrNull { it.id == snapshot.settings.activeSubscriptionId }
            ?: snapshot.subscriptions.firstOrNull() ?: error("Сначала добавьте подписку")
        val server = subscription.servers.firstOrNull { it.id == snapshot.settings.selectedServerId }
            ?: subscription.servers.firstOrNull() ?: error("В подписке нет серверов")
        val rulesDir = java.io.File(filesDir, "rules").apply { mkdirs() }
        val geoIp = copyAsset("geoip-ru.srs", rulesDir)
        val geoSite = copyAsset("geosite-category-ru.srs", rulesDir)

        val healthPort = Libbox.availablePort(12_000)
        val config = SingBoxConfigBuilder.build(server, snapshot.settings, geoIp.absolutePath, geoSite.absolutePath, healthPort)
        Libbox.checkConfig(config)
        commandServer = Libbox.newCommandServer(this, this).also {
            it.startWithTemporaryPort(); it.startOrReloadService(config, null)
        }
        verifyTunnel(healthPort)
        VpnState.status.value = ConnectionStatus(ConnectionPhase.CONNECTED, "Подключено: ${server.name}")
        updateNotification("Подключено: ${server.name}")
    }

    private fun verifyTunnel(port: Int) {
        val client = Libbox.newHTTPClient()
        try {
            client.modernTLS(); client.trySocks5(port)
            client.newRequest().apply {
                setMethod("GET"); setURL("https://www.cloudflare.com/cdn-cgi/trace"); setUserAgent("TempleTunnel/0.14.1 Android")
            }.execute()
        } catch (error: Throwable) {
            throw IllegalStateException("VPN-сервер не подтвердил защищённое соединение", error)
        } finally { client.close() }
    }

    private fun copyAsset(name: String, directory: java.io.File): java.io.File {
        val target = java.io.File(directory, name)
        if (!target.exists()) assets.open(name).use { input -> target.outputStream().use(input::copyTo) }
        return target
    }

    private fun stopTunnel() {
        VpnState.status.value = ConnectionStatus(ConnectionPhase.STOPPING, "Отключение…")
        stopCore()
        VpnState.status.value = ConnectionStatus()
        stopForeground(STOP_FOREGROUND_REMOVE); stopSelf()
    }
    private fun stopCore() {
        runCatching { commandServer?.closeService() }; runCatching { commandServer?.close() }; commandServer = null
        runCatching { tun?.close() }; tun = null
    }
    private fun fail(error: Throwable) {
        stopCore(); val message = error.message ?: "Не удалось запустить VPN"
        VpnState.status.value = ConnectionStatus(ConnectionPhase.ERROR, message)
        updateNotification("Ошибка: $message")
    }
    override fun onDestroy() { stopCore(); super.onDestroy() }
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
        tun = builder.establish() ?: error("Android отозвал разрешение VPN")
        return tun!!.fd
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
            override fun onAvailable(network: Network) = updateDefaultInterface(listener)
            override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) = updateDefaultInterface(listener)
            override fun onLinkPropertiesChanged(network: Network, linkProperties: LinkProperties) = updateDefaultInterface(listener)
            override fun onLost(network: Network) = updateDefaultInterface(listener)
        }.also(cm::registerDefaultNetworkCallback)
        updateDefaultInterface(listener)
    }
    override fun closeDefaultInterfaceMonitor(listener: InterfaceUpdateListener) {
        if (monitor === listener) monitor = null
        networkCallback?.let { runCatching { getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(it) } }
        networkCallback = null
    }
    private fun updateDefaultInterface(listener: InterfaceUpdateListener) {
        val cm = getSystemService(ConnectivityManager::class.java)
        val network = cm.activeNetwork ?: return
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
private fun StringIterator.addPackages(block: (String) -> Unit) { while (hasNext()) runCatching { block(next()) } }
