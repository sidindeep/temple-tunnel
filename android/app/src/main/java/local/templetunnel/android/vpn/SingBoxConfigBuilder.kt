package local.templetunnel.android.vpn

import local.templetunnel.android.data.AppSettings
import local.templetunnel.android.data.RoutingMode
import local.templetunnel.android.data.ServerProfile
import org.json.JSONArray
import org.json.JSONObject

object SingBoxConfigBuilder {
    fun build(server: ServerProfile, settings: AppSettings, geoIpPath: String, geoSitePath: String, healthPort: Int = 0): String {
        require(settings.routingMode != RoutingMode.SELECTED || settings.selectedPackages.isNotEmpty()) {
            "Для режима выбранных приложений отметьте хотя бы одно приложение"
        }
        val inbound = JSONObject().apply {
            put("type", "tun"); put("tag", "tun-in"); put("interface_name", "temple-tun")
            put("address", JSONArray(buildList { add("172.31.254.1/30"); if (settings.ipv6Enabled) add("fd7a:7465:6d70::1/126") }))
            put("mtu", 1500); put("auto_route", true); put("strict_route", true); put("stack", "mixed")
            if (settings.routingMode == RoutingMode.SELECTED) put("include_package", JSONArray(settings.selectedPackages.toList()))
            if (settings.routingMode == RoutingMode.BYPASS) put("exclude_package", JSONArray(settings.selectedPackages.toList()))
        }
        val rules = JSONArray().apply {
            if (!settings.ipv6Enabled) put(rule("reject").put("ip_version", 6))
            put(rule("sniff")); put(rule("hijack-dns").put("protocol", "dns"))
            put(rule("route", "direct").put("ip_is_private", true))
            addCustom(settings.customBlock, "reject", null)
            addCustom(settings.customProxy, "route", "proxy")
            addCustom(settings.customDirect, "route", "direct")
            if (settings.routingMode != RoutingMode.FULL || !settings.russianSitesViaVpn) {
                put(rule("route", "direct").put("rule_set", JSONArray(listOf("geoip-ru", "geosite-category-ru"))))
            }
        }
        val dnsRules = JSONArray().apply {
            put(JSONObject().put("domain_suffix", JSONArray(listOf(".local", ".localhost", ".lan"))).put("action", "route").put("server", "dns-direct"))
            if (settings.routingMode != RoutingMode.FULL || !settings.russianSitesViaVpn) {
                put(JSONObject().put("rule_set", "geosite-category-ru").put("action", "route").put("server", "dns-direct"))
            }
        }
        return JSONObject().apply {
            put("log", JSONObject().put("level", "info").put("timestamp", true))
            put("dns", JSONObject()
                .put("servers", JSONArray(listOf(
                    JSONObject().put("type", "local").put("tag", "dns-direct"),
                    JSONObject().put("type", "https").put("tag", "dns-proxy").put("server", "1.1.1.1").put("server_port", 443)
                        .put("path", "/dns-query").put("tls", JSONObject().put("enabled", true).put("server_name", "cloudflare-dns.com")).put("detour", "proxy"),
                )))
                .put("rules", dnsRules).put("final", "dns-proxy").put("strategy", if (settings.ipv6Enabled) "prefer_ipv4" else "ipv4_only"))
            put("inbounds", JSONArray(buildList {
                add(inbound)
                if (healthPort > 0) add(JSONObject().put("type", "mixed").put("tag", "health-in").put("listen", "127.0.0.1").put("listen_port", healthPort))
            }))
            put("outbounds", JSONArray(listOf(outbound(server), JSONObject().put("type", "direct").put("tag", "direct"))))
            if (healthPort > 0) rules.put(0, rule("route", "proxy").put("inbound", "health-in"))
            put("route", JSONObject().put("rules", rules).put("rule_set", JSONArray(listOf(
                ruleSet("geoip-ru", geoIpPath), ruleSet("geosite-category-ru", geoSitePath),
            ))).put("final", "proxy").put("auto_detect_interface", true).put("default_domain_resolver", "dns-direct"))
        }.toString()
    }

    private fun outbound(s: ServerProfile): JSONObject {
        if (s.protocol == "hysteria2") return JSONObject().apply {
            put("type", "hysteria2"); put("tag", "proxy"); put("server", s.host); put("server_port", s.port); put("password", s.password)
            put("tls", tls(s)); if (s.obfsType.isNotBlank()) put("obfs", JSONObject().put("type", s.obfsType).put("password", s.obfsPassword))
        }
        return JSONObject().apply {
            put("type", "vless"); put("tag", "proxy"); put("server", s.host); put("server_port", s.port); put("uuid", s.uuid)
            put("packet_encoding", s.packetEncoding); if (s.flow.isNotBlank()) put("flow", s.flow)
            if (s.security != "none") put("tls", tls(s))
            transport(s)?.let { put("transport", it) }
        }
    }
    private fun tls(s: ServerProfile) = JSONObject().apply {
        put("enabled", true); put("server_name", s.serverName.ifBlank { s.host }); put("insecure", s.allowInsecure)
        if (s.fingerprint.isNotBlank()) put("utls", JSONObject().put("enabled", true).put("fingerprint", s.fingerprint))
        if (s.security == "reality") put("reality", JSONObject().put("enabled", true).put("public_key", s.publicKey).put("short_id", s.shortId))
    }
    private fun transport(s: ServerProfile): JSONObject? = when (s.transport) {
        "tcp", "hysteria2", "" -> null
        "grpc" -> JSONObject().put("type", "grpc").put("service_name", s.serviceName)
        "ws", "websocket" -> JSONObject().put("type", "ws").put("path", s.path.ifBlank { "/" }).apply { if (s.hostHeader.isNotBlank()) put("headers", JSONObject().put("Host", s.hostHeader)) }
        "httpupgrade" -> JSONObject().put("type", "httpupgrade").put("path", s.path.ifBlank { "/" }).apply { if (s.hostHeader.isNotBlank()) put("host", s.hostHeader) }
        "http", "h2" -> JSONObject().put("type", "http").put("path", s.path.ifBlank { "/" }).apply { if (s.hostHeader.isNotBlank()) put("host", JSONArray(listOf(s.hostHeader))) }
        "xhttp" -> throw IllegalArgumentException("XHTTP требует отдельную сборку ядра с тегом with_xhttp")
        else -> throw IllegalArgumentException("Транспорт ${s.transport} не поддерживается")
    }
    private fun rule(action: String, outbound: String? = null) = JSONObject().put("action", action).apply { outbound?.let { put("outbound", it) } }
    private fun ruleSet(tag: String, path: String) = JSONObject().put("type", "local").put("tag", tag).put("format", "binary").put("path", path)
    private fun JSONArray.addCustom(entries: List<String>, action: String, outbound: String?) {
        val domains = entries.filterNot { it.contains('/') }
        val cidrs = entries.filter { it.contains('/') }
        if (domains.isNotEmpty()) put(rule(action, outbound).put("domain_suffix", JSONArray(domains)))
        if (cidrs.isNotEmpty()) put(rule(action, outbound).put("ip_cidr", JSONArray(cidrs)))
    }
}
