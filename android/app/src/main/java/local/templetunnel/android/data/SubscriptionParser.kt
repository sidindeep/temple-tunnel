package local.templetunnel.android.data

import android.util.Base64
import java.net.IDN
import java.net.URI
import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import java.security.MessageDigest

object SubscriptionParser {
    private const val MAX_SOURCE_BYTES = 256 * 1024
    private val supportedTransports = setOf("tcp", "grpc", "ws", "websocket", "httpupgrade", "http", "h2", "xhttp")

    fun parse(body: String): List<ServerProfile> {
        require(body.toByteArray().size <= MAX_SOURCE_BYTES) { "Подписка слишком большая" }
        val decoded = decode(body)
        val result = linkedMapOf<String, ServerProfile>()
        var firstError: Throwable? = null
        decoded.lineSequence().map(String::trim).filter(String::isNotEmpty).forEach { line ->
            try {
                val profile = when {
                    line.startsWith("vless://", true) -> parseVless(line)
                    line.startsWith("hysteria2://", true) || line.startsWith("hy2://", true) -> parseHysteria2(line)
                    else -> return@forEach
                }
                result.putIfAbsent(profile.id, profile)
            } catch (error: Throwable) {
                if (firstError == null) firstError = error
            }
        }
        if (result.isEmpty()) throw IllegalArgumentException(firstError?.message ?: "В подписке нет поддерживаемых серверов")
        return result.values.toList()
    }

    private fun decode(body: String): String {
        val text = body.trim().removePrefix("\uFEFF")
        if (Regex("(?im)^(vless|hysteria2|hy2)://").containsMatchIn(text)) return text
        val normalized = text.replace("\\s+".toRegex(), "").replace('-', '+').replace('_', '/')
        return runCatching {
            String(Base64.decode(normalized, Base64.DEFAULT), StandardCharsets.UTF_8).trim()
        }.getOrElse { throw IllegalArgumentException("Формат подписки не распознан") }
    }

    fun parseVless(source: String): ServerProfile {
        val uri = URI(source)
        require(uri.scheme.equals("vless", true)) { "Ожидается VLESS-профиль" }
        val uuid = decodePart(uri.rawUserInfo?.substringBefore(':').orEmpty())
        val host = uri.host ?: parseBracketHost(uri.rawAuthority)
        val port = if (uri.port > 0) uri.port else 443
        require(uuid.isNotBlank() && !host.isNullOrBlank() && port in 1..65535) { "Некорректные UUID, адрес или порт VLESS" }
        require(!isLoopback(host)) { "Локальный адрес нельзя использовать как VPN-сервер" }
        val q = query(uri.rawQuery)
        val transport = q["type"]?.lowercase() ?: "tcp"
        require(transport in supportedTransports) { "Транспорт $transport пока не поддерживается" }
        val security = q["security"]?.lowercase() ?: "none"
        val publicKey = q["pbk"] ?: q["publicKey"].orEmpty()
        if (security == "reality") require(Regex("^[A-Za-z0-9_-]{43}=?$").matches(publicKey)) { "Некорректный публичный ключ REALITY" }
        return ServerProfile(
            id = digest(source), name = decodePart(uri.rawFragment ?: "").ifBlank { "$host:$port" },
            protocol = "vless", host = host, port = port, uuid = uuid,
            flow = q["flow"].orEmpty(), encryption = q["encryption"] ?: "none", security = security,
            transport = transport, serverName = q["sni"] ?: q["serverName"] ?: host,
            fingerprint = q["fp"] ?: "chrome", publicKey = publicKey,
            shortId = q["sid"] ?: q["shortId"].orEmpty(), serviceName = q["serviceName"] ?: q["service_name"].orEmpty(),
            path = q["path"].orEmpty(), hostHeader = q["host"].orEmpty(),
            allowInsecure = q["allowInsecure"] in setOf("1", "true") || q["insecure"] in setOf("1", "true"),
            packetEncoding = q["packetEncoding"] ?: q["packet_encoding"] ?: "xudp",
        )
    }

    fun parseHysteria2(source: String): ServerProfile {
        val uri = URI(source)
        require(uri.scheme.lowercase() in setOf("hysteria2", "hy2")) { "Ожидается профиль Hysteria 2" }
        val host = uri.host ?: parseBracketHost(uri.rawAuthority)
        val port = if (uri.port > 0) uri.port else 443
        val password = decodePart(uri.rawUserInfo.orEmpty())
        require(!host.isNullOrBlank() && password.isNotBlank() && port in 1..65535 && !isLoopback(host)) { "Некорректный профиль Hysteria 2" }
        val q = query(uri.rawQuery)
        val obfs = q["obfs"].orEmpty()
        if (obfs.isNotEmpty()) require(obfs == "salamander" && !q["obfs-password"].isNullOrBlank()) { "Некорректная маскировка Hysteria 2" }
        return ServerProfile(
            id = digest(source), name = decodePart(uri.rawFragment ?: "").ifBlank { "$host:$port" },
            protocol = "hysteria2", host = host, port = port, password = password,
            security = "tls", transport = "hysteria2", serverName = q["sni"] ?: host,
            allowInsecure = q["insecure"] in setOf("1", "true"), obfsType = obfs,
            obfsPassword = q["obfs-password"].orEmpty(),
        )
    }

    private fun query(value: String?): Map<String, String> = value.orEmpty().split('&').filter { it.isNotBlank() }.associate { part ->
        val pieces = part.split('=', limit = 2)
        decodePart(pieces[0]) to decodePart(pieces.getOrElse(1) { "" })
    }
    private fun decodePart(value: String) = URLDecoder.decode(value.replace("+", "%2B"), StandardCharsets.UTF_8.name())
    private fun digest(value: String) = MessageDigest.getInstance("SHA-256").digest(value.toByteArray()).take(12).joinToString("") { "%02x".format(it) }
    private fun isLoopback(host: String) = host.equals("localhost", true) || host == "::1" || host.startsWith("127.")
    private fun parseBracketHost(authority: String?): String? = authority?.substringAfter('@')?.substringBeforeLast(':')?.trim('[', ']')?.let { IDN.toASCII(it) }
}
