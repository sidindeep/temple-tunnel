package local.templetunnel.android.data

import org.junit.Assert.assertEquals
import org.junit.Test
import kotlin.test.assertFailsWith

class SubscriptionParserTest {
    @Test fun parsesRealityVlessProfile() {
        val key = "abcdefghijklmnopqrstuvwxyzABCDEFGH123456789"
        val server = SubscriptionParser.parseVless(
            "vless://11111111-1111-4111-8111-111111111111@example.com:443?security=reality&type=grpc&sni=cdn.example.com&pbk=$key&sid=abcd&serviceName=main#Moscow"
        )
        assertEquals("Moscow", server.name)
        assertEquals("grpc", server.transport)
        assertEquals("cdn.example.com", server.serverName)
        assertEquals("main", server.serviceName)
    }

    @Test fun rejectsLoopbackServer() {
        assertFailsWith<IllegalArgumentException> {
            SubscriptionParser.parseVless("vless://11111111-1111-4111-8111-111111111111@127.0.0.1:443#bad")
        }
    }
}
