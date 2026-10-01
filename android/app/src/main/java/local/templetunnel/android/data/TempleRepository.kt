package local.templetunnel.android.data

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.io.ByteArrayOutputStream
import java.util.UUID

class TempleRepository(context: Context) {
    private val appContext = context.applicationContext
    private val masterKey = MasterKey.Builder(appContext).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
    private val prefs = EncryptedSharedPreferences.create(
        appContext, "temple-secure", masterKey,
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

    @Synchronized fun load(): AppSnapshot {
        val saved = prefs.getString("snapshot", null) ?: return AppSnapshot()
        return decode(saved)
    }
    @Synchronized fun save(snapshot: AppSnapshot) {
        check(prefs.edit().putString("snapshot", encode(snapshot).toString()).commit()) { "Не удалось сохранить настройки" }
    }

    fun import(name: String, source: String): Subscription {
        require(source.toByteArray().size <= 256 * 1024) { "Ссылка или ключ слишком большие" }
        require(!source.trim().startsWith("http://", true)) { "Подписка допускает только HTTPS" }
        val body = if (source.trim().startsWith("https://", true)) download(source.trim()) else source
        return Subscription(UUID.randomUUID().toString(), name.ifBlank { "Подписка" }, source.trim(), SubscriptionParser.parse(body))
    }

    fun refresh(subscription: Subscription): Subscription {
        val body = if (subscription.source.startsWith("https://", true)) download(subscription.source) else subscription.source
        return subscription.copy(servers = SubscriptionParser.parse(body), updatedAt = System.currentTimeMillis())
    }

    private fun download(source: String): String {
        require(URL(source).protocol == "https") { "Подписка допускает только HTTPS" }
        val connection = (URL(source).openConnection() as HttpURLConnection).apply {
            connectTimeout = 15_000; readTimeout = 15_000; instanceFollowRedirects = false
            setRequestProperty("Accept", "text/plain, application/octet-stream;q=0.9")
            setRequestProperty("User-Agent", "TempleTunnel/0.14.1 Android")
        }
        try {
            require(connection.responseCode in 200..299) { "Сервер подписки ответил HTTP ${connection.responseCode}" }
            require(connection.contentLengthLong <= 5L * 1024 * 1024 || connection.contentLengthLong < 0) { "Ответ подписки слишком большой" }
            val bytes = connection.inputStream.use { input ->
                val output = ByteArrayOutputStream()
                val buffer = ByteArray(16 * 1024)
                val limit = 5 * 1024 * 1024 + 1
                while (output.size() < limit) {
                    val read = input.read(buffer, 0, minOf(buffer.size, limit - output.size()))
                    if (read < 0) break
                    output.write(buffer, 0, read)
                }
                output.toByteArray()
            }
            require(bytes.size <= 5 * 1024 * 1024) { "Ответ подписки слишком большой" }
            return bytes.toString(Charsets.UTF_8)
        } finally { connection.disconnect() }
    }

    private fun encode(snapshot: AppSnapshot) = JSONObject().apply {
        put("subscriptions", JSONArray(snapshot.subscriptions.map(::subscriptionJson)))
        put("settings", settingsJson(snapshot.settings))
    }

    private fun decode(text: String): AppSnapshot {
        val root = JSONObject(text)
        return AppSnapshot(root.getJSONArray("subscriptions").objects().map(::subscriptionFromJson), settingsFromJson(root.getJSONObject("settings")))
    }

    private fun subscriptionJson(value: Subscription) = JSONObject().apply {
        put("id", value.id); put("name", value.name); put("source", value.source); put("updatedAt", value.updatedAt)
        put("servers", JSONArray(value.servers.map(::serverJson)))
    }
    private fun subscriptionFromJson(value: JSONObject) = Subscription(
        value.getString("id"), value.getString("name"), value.getString("source"),
        value.getJSONArray("servers").objects().map(::serverFromJson), value.optLong("updatedAt"),
    )
    private fun serverJson(s: ServerProfile) = JSONObject().apply {
        put("id",s.id); put("name",s.name); put("protocol",s.protocol); put("host",s.host); put("port",s.port)
        put("uuid",s.uuid); put("password",s.password); put("flow",s.flow); put("encryption",s.encryption)
        put("security",s.security); put("transport",s.transport); put("serverName",s.serverName); put("fingerprint",s.fingerprint)
        put("publicKey",s.publicKey); put("shortId",s.shortId); put("serviceName",s.serviceName); put("path",s.path)
        put("hostHeader",s.hostHeader); put("allowInsecure",s.allowInsecure); put("packetEncoding",s.packetEncoding)
        put("obfsType",s.obfsType); put("obfsPassword",s.obfsPassword); put("latencyMs",s.latencyMs)
    }
    private fun serverFromJson(j: JSONObject) = ServerProfile(
        id=j.s("id"), name=j.s("name"), protocol=j.s("protocol"), host=j.s("host"), port=j.optInt("port"),
        uuid=j.s("uuid"), password=j.s("password"), flow=j.s("flow"), encryption=j.s("encryption","none"),
        security=j.s("security","none"), transport=j.s("transport","tcp"), serverName=j.s("serverName"),
        fingerprint=j.s("fingerprint","chrome"), publicKey=j.s("publicKey"), shortId=j.s("shortId"), serviceName=j.s("serviceName"),
        path=j.s("path"), hostHeader=j.s("hostHeader"), allowInsecure=j.optBoolean("allowInsecure"),
        packetEncoding=j.s("packetEncoding","xudp"), obfsType=j.s("obfsType"), obfsPassword=j.s("obfsPassword"),
        latencyMs=j.optLong("latencyMs").takeIf { j.has("latencyMs") && !j.isNull("latencyMs") },
    )
    private fun settingsJson(s: AppSettings) = JSONObject().apply {
        put("activeSubscriptionId", s.activeSubscriptionId); put("selectedServerId", s.selectedServerId)
        put("routingMode", s.routingMode.name); put("selectedPackages", JSONArray(s.selectedPackages.toList()))
        put("russianSitesViaVpn", s.russianSitesViaVpn); put("ipv6Enabled", s.ipv6Enabled)
        put("customProxy", JSONArray(s.customProxy)); put("customDirect", JSONArray(s.customDirect)); put("customBlock", JSONArray(s.customBlock))
        put("automaticServer", s.automaticServer)
    }
    private fun settingsFromJson(j: JSONObject) = AppSettings(
        activeSubscriptionId=j.optString("activeSubscriptionId").takeIf(String::isNotBlank),
        selectedServerId=j.optString("selectedServerId").takeIf(String::isNotBlank),
        routingMode=runCatching { RoutingMode.valueOf(j.optString("routingMode","BYPASS")) }.getOrDefault(RoutingMode.BYPASS),
        selectedPackages=j.optJSONArray("selectedPackages")?.strings()?.toSet().orEmpty(),
        russianSitesViaVpn=j.optBoolean("russianSitesViaVpn",true), ipv6Enabled=j.optBoolean("ipv6Enabled"),
        customProxy=j.optJSONArray("customProxy")?.strings().orEmpty(), customDirect=j.optJSONArray("customDirect")?.strings().orEmpty(),
        customBlock=j.optJSONArray("customBlock")?.strings().orEmpty(), automaticServer=j.optBoolean("automaticServer",true),
    )
}

private fun JSONArray.objects() = (0 until length()).map { getJSONObject(it) }
private fun JSONArray.strings() = (0 until length()).map { getString(it) }
private fun JSONObject.s(key: String, fallback: String = "") = optString(key, fallback)
