package local.templetunnel.android.vpn

import local.templetunnel.android.data.AppSettings
import local.templetunnel.android.data.RoutingMode
import local.templetunnel.android.data.ServerProfile
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.test.assertFailsWith

class SingBoxConfigBuilderTest {
    private val server = ServerProfile(
        id = "one", name = "Test", protocol = "vless", host = "example.com", port = 443,
        uuid = "11111111-1111-4111-8111-111111111111", security = "tls", serverName = "example.com",
    )

    @Test fun selectedModeUsesAndroidPackageFilter() {
        val json = JSONObject(SingBoxConfigBuilder.build(server, AppSettings(
            routingMode = RoutingMode.SELECTED, selectedPackages = setOf("org.example.browser"),
        ), "/rules/ip.srs", "/rules/site.srs"))
        val inbound = json.getJSONArray("inbounds").getJSONObject(0)
        assertEquals("org.example.browser", inbound.getJSONArray("include_package").getString(0))
        assertEquals("proxy", json.getJSONObject("route").getString("final"))
    }

    @Test fun splitModeAddsRussianDirectRuleAndBlocksIpv6() {
        val json = JSONObject(SingBoxConfigBuilder.build(server, AppSettings(routingMode = RoutingMode.BYPASS), "ip", "site"))
        val rules = json.getJSONObject("route").getJSONArray("rules").toString()
        assertTrue(rules.contains("geoip-ru"))
        assertTrue(rules.contains("ip_version"))
    }

    @Test fun xhttpRequiresCompatibleCoreBuild() {
        assertFailsWith<IllegalArgumentException> {
            SingBoxConfigBuilder.build(server.copy(transport = "xhttp"), AppSettings(), "ip", "site")
        }
    }
}
