package local.templetunnel.android.vpn

import kotlinx.coroutines.flow.MutableStateFlow

enum class ConnectionPhase { DISCONNECTED, CONNECTING, CONNECTED, STOPPING, ERROR }
data class ConnectionStatus(val phase: ConnectionPhase = ConnectionPhase.DISCONNECTED, val message: String = "Отключено")

object VpnState {
    val status = MutableStateFlow(ConnectionStatus())
}
