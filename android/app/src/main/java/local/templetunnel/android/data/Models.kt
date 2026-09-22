package local.templetunnel.android.data

data class ServerProfile(
    val id: String,
    val name: String,
    val protocol: String,
    val host: String,
    val port: Int,
    val uuid: String = "",
    val password: String = "",
    val flow: String = "",
    val encryption: String = "none",
    val security: String = "none",
    val transport: String = "tcp",
    val serverName: String = "",
    val fingerprint: String = "chrome",
    val publicKey: String = "",
    val shortId: String = "",
    val serviceName: String = "",
    val path: String = "",
    val hostHeader: String = "",
    val allowInsecure: Boolean = false,
    val packetEncoding: String = "xudp",
    val obfsType: String = "",
    val obfsPassword: String = "",
    val latencyMs: Long? = null,
)

data class Subscription(
    val id: String,
    val name: String,
    val source: String,
    val servers: List<ServerProfile>,
    val updatedAt: Long = System.currentTimeMillis(),
)

enum class RoutingMode { FULL, SELECTED, BYPASS }

data class AppSettings(
    val activeSubscriptionId: String? = null,
    val selectedServerId: String? = null,
    val routingMode: RoutingMode = RoutingMode.BYPASS,
    val selectedPackages: Set<String> = emptySet(),
    val russianSitesViaVpn: Boolean = true,
    val ipv6Enabled: Boolean = false,
    val customProxy: List<String> = emptyList(),
    val customDirect: List<String> = emptyList(),
    val customBlock: List<String> = emptyList(),
    val automaticServer: Boolean = true,
)

data class InstalledApp(val label: String, val packageName: String)

data class AppSnapshot(
    val subscriptions: List<Subscription> = emptyList(),
    val settings: AppSettings = AppSettings(),
)
