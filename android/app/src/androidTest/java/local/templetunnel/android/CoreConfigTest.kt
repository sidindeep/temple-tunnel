package local.templetunnel.android

import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.nekohasekai.libbox.Libbox
import local.templetunnel.android.data.AppSettings
import local.templetunnel.android.data.RoutingMode
import local.templetunnel.android.data.ServerProfile
import local.templetunnel.android.vpn.SingBoxConfigBuilder
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

@RunWith(AndroidJUnit4::class)
class CoreConfigTest {
    @Test fun libboxAcceptsGeneratedAndroidProfiles() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val rules = File(context.cacheDir, "config-test-rules").apply { mkdirs() }
        val ip = File(rules, "geoip-ru.srs").also { file -> context.assets.open(file.name).use { it.copyTo(file.outputStream()) } }
        val site = File(rules, "geosite-category-ru.srs").also { file -> context.assets.open(file.name).use { it.copyTo(file.outputStream()) } }
        val server = ServerProfile(
            id = "test", name = "test", protocol = "vless", host = "example.org", port = 443,
            uuid = "11111111-1111-4111-8111-111111111111", security = "reality",
            serverName = "example.org", publicKey = "abcdefghijklmnopqrstuvwxyzABCDEFGH123456789",
        )
        Log.i("TempleCoreTest", "libbox=${Libbox.version()}")
        listOf(
            AppSettings(routingMode = RoutingMode.FULL),
            AppSettings(routingMode = RoutingMode.SELECTED, selectedPackages = setOf("com.android.chrome")),
            AppSettings(routingMode = RoutingMode.BYPASS, selectedPackages = setOf("com.android.chrome")),
        ).forEach { settings ->
            Libbox.checkConfig(SingBoxConfigBuilder.build(server, settings, ip.absolutePath, site.absolutePath, 12345))
        }
        Libbox.checkConfig(SingBoxConfigBuilder.build(
            server.copy(protocol = "hysteria2", transport = "hysteria2", security = "tls", password = "test"),
            AppSettings(), ip.absolutePath, site.absolutePath, 12345,
        ))
    }
}
