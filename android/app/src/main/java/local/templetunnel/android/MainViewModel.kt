package local.templetunnel.android

import android.app.Application
import android.content.Intent
import android.content.pm.ApplicationInfo
import androidx.core.content.ContextCompat
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import local.templetunnel.android.data.*
import local.templetunnel.android.vpn.TempleVpnService
import java.net.InetSocketAddress
import java.net.Socket

data class UiState(
    val snapshot: AppSnapshot = AppSnapshot(),
    val installedApps: List<InstalledApp> = emptyList(),
    val busy: Boolean = false,
    val message: String? = null,
) {
    val activeSubscription get() = snapshot.subscriptions.firstOrNull { it.id == snapshot.settings.activeSubscriptionId } ?: snapshot.subscriptions.firstOrNull()
    val activeServer get() = activeSubscription?.servers?.firstOrNull { it.id == snapshot.settings.selectedServerId } ?: activeSubscription?.servers?.firstOrNull()
}

class MainViewModel(application: Application) : AndroidViewModel(application) {
    private val repository = (application as TempleApplication).repository
    private val _ui = MutableStateFlow(UiState(snapshot = repository.load()))
    val ui: StateFlow<UiState> = _ui.asStateFlow()

    init { loadInstalledApps() }

    fun importSubscription(name: String, source: String) = work {
        val subscription = repository.import(name, source)
        mutate { state ->
            state.copy(subscriptions = state.subscriptions + subscription,
                settings = state.settings.copy(activeSubscriptionId = subscription.id, selectedServerId = subscription.servers.firstOrNull()?.id))
        }
        "Добавлено серверов: ${subscription.servers.size}"
    }

    fun refreshSubscription() = work {
        val active = _ui.value.activeSubscription ?: error("Нет активной подписки")
        val refreshed = repository.refresh(active)
        mutate { state -> state.copy(subscriptions = state.subscriptions.map { if (it.id == active.id) refreshed else it }) }
        "Подписка обновлена"
    }

    fun deleteSubscription(id: String) {
        mutate { state ->
            val remaining = state.subscriptions.filterNot { it.id == id }
            val active = remaining.firstOrNull()
            state.copy(subscriptions = remaining, settings = state.settings.copy(activeSubscriptionId = active?.id, selectedServerId = active?.servers?.firstOrNull()?.id))
        }
    }
    fun selectSubscription(id: String) = mutate { state ->
        val subscription = state.subscriptions.first { it.id == id }
        state.copy(settings = state.settings.copy(activeSubscriptionId = id, selectedServerId = subscription.servers.firstOrNull()?.id))
    }
    fun selectServer(id: String) = mutate { it.copy(settings = it.settings.copy(selectedServerId = id, automaticServer = false)) }
    fun setAutomatic(value: Boolean) = mutate { it.copy(settings = it.settings.copy(automaticServer = value)) }
    fun setMode(mode: RoutingMode) = mutate { it.copy(settings = it.settings.copy(routingMode = mode)) }
    fun setRussianViaVpn(value: Boolean) = mutate { it.copy(settings = it.settings.copy(russianSitesViaVpn = value)) }
    fun setIpv6(value: Boolean) = mutate { it.copy(settings = it.settings.copy(ipv6Enabled = value)) }
    fun togglePackage(packageName: String) = mutate { state ->
        val packages = state.settings.selectedPackages.toMutableSet().apply { if (!add(packageName)) remove(packageName) }
        state.copy(settings = state.settings.copy(selectedPackages = packages))
    }
    fun setRoutes(proxy: String, direct: String, block: String) = mutate { state ->
        state.copy(settings = state.settings.copy(customProxy = routeLines(proxy), customDirect = routeLines(direct), customBlock = routeLines(block)))
    }
    fun clearMessage() { _ui.value = _ui.value.copy(message = null) }

    fun measureServers() = work {
        val active = _ui.value.activeSubscription ?: error("Нет активной подписки")
        val measured = withContext(Dispatchers.IO) {
            active.servers.map { server ->
                val started = System.nanoTime()
                val latency = runCatching { Socket().use { it.connect(InetSocketAddress(server.host, server.port), 4_000) }; (System.nanoTime() - started) / 1_000_000 }.getOrNull()
                server.copy(latencyMs = latency)
            }
        }
        val best = measured.filter { it.latencyMs != null }.minByOrNull { it.latencyMs!! }
        mutate { state -> state.copy(subscriptions = state.subscriptions.map { if (it.id == active.id) it.copy(servers = measured) else it },
            settings = state.settings.copy(selectedServerId = if (state.settings.automaticServer) best?.id ?: state.settings.selectedServerId else state.settings.selectedServerId)) }
        if (best != null) "Лучший сервер: ${best.name}, ${best.latencyMs} мс" else "Доступные серверы не найдены"
    }

    fun startVpn() {
        val app = getApplication<Application>()
        ContextCompat.startForegroundService(app, Intent(app, TempleVpnService::class.java).setAction(TempleVpnService.ACTION_CONNECT))
    }
    fun stopVpn() {
        val app = getApplication<Application>()
        app.startService(Intent(app, TempleVpnService::class.java).setAction(TempleVpnService.ACTION_DISCONNECT))
    }

    private fun work(block: suspend () -> String) {
        if (_ui.value.busy) return
        viewModelScope.launch {
            _ui.value = _ui.value.copy(busy = true, message = null)
            val message = runCatching { block() }.fold({ it }, { "Ошибка: ${it.message ?: "операция не выполнена"}" })
            _ui.value = _ui.value.copy(busy = false, message = message)
        }
    }
    private fun mutate(block: (AppSnapshot) -> AppSnapshot) {
        val updated = block(_ui.value.snapshot)
        repository.save(updated)
        _ui.value = _ui.value.copy(snapshot = updated)
    }
    private fun loadInstalledApps() = viewModelScope.launch(Dispatchers.IO) {
        val pm = getApplication<Application>().packageManager
        val apps = pm.getInstalledApplications(0).asSequence()
            .filter { it.packageName != getApplication<Application>().packageName && (it.flags and ApplicationInfo.FLAG_SYSTEM == 0 || pm.getLaunchIntentForPackage(it.packageName) != null) }
            .map { InstalledApp(pm.getApplicationLabel(it).toString(), it.packageName) }
            .sortedBy { it.label.lowercase() }.toList()
        _ui.value = _ui.value.copy(installedApps = apps)
    }
    private fun routeLines(value: String) = value.lineSequence().map(String::trim).filter(String::isNotEmpty).distinct().take(500).toList()
}
