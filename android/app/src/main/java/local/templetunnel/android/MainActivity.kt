package local.templetunnel.android

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.net.VpnService
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.selectable
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import local.templetunnel.android.data.RoutingMode
import local.templetunnel.android.vpn.ConnectionPhase
import local.templetunnel.android.vpn.VpnState

class MainActivity : ComponentActivity() {
    private val model by viewModels<MainViewModel>()
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { TempleTheme { TempleApp(model) } }
    }
}

@Composable private fun TempleTheme(content: @Composable () -> Unit) {
    val colors = darkColorScheme(primary = Color(0xFFE8BD62), secondary = Color(0xFF8ED0C6), background = Color(0xFF101114), surface = Color(0xFF1A1C21))
    MaterialTheme(colorScheme = colors, typography = Typography(), content = content)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable private fun TempleApp(model: MainViewModel) {
    val ui by model.ui.collectAsStateWithLifecycle()
    val vpn by VpnState.status.collectAsStateWithLifecycle()
    var tab by remember { mutableIntStateOf(0) }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result -> if (result.resultCode == Activity.RESULT_OK) model.startVpn() }
    val notifications = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { }
    LaunchedEffect(Unit) { if (Build.VERSION.SDK_INT >= 33) notifications.launch(Manifest.permission.POST_NOTIFICATIONS) }

    Scaffold(
        topBar = { TopAppBar(title = { Column { Text("Temple Tunnel", fontWeight = FontWeight.Bold); Text(vpn.message, style = MaterialTheme.typography.labelSmall) } }) },
        bottomBar = {
            NavigationBar {
                listOf(Triple("Главная", Icons.Default.Home, 0), Triple("Приложения", Icons.Default.Apps, 1), Triple("Настройки", Icons.Default.Settings, 2)).forEach { (title, icon, index) ->
                    NavigationBarItem(selected = tab == index, onClick = { tab = index }, icon = { Icon(icon, title) }, label = { Text(title) })
                }
            }
        },
        snackbarHost = { SnackbarHost(remember { SnackbarHostState() }.also { host -> LaunchedEffect(ui.message) { ui.message?.let { host.showSnackbar(it); model.clearMessage() } } }) },
    ) { padding ->
        Box(Modifier.padding(padding).fillMaxSize()) {
            when (tab) {
                0 -> HomeScreen(ui, vpn.phase, model) {
                    val prepare = VpnService.prepare(model.getApplication())
                    if (prepare == null) model.startVpn() else permission.launch(prepare)
                }
                1 -> AppsScreen(ui, model)
                else -> SettingsScreen(ui, model)
            }
            if (ui.busy) LinearProgressIndicator(Modifier.fillMaxWidth().align(Alignment.TopCenter))
        }
    }
}

@Composable private fun HomeScreen(ui: UiState, phase: ConnectionPhase, model: MainViewModel, connect: () -> Unit) {
    LazyColumn(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            ElevatedCard(Modifier.fillMaxWidth()) { Column(Modifier.padding(18.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Text(ui.activeServer?.name ?: "Сервер не выбран", style = MaterialTheme.typography.titleLarge)
                Spacer(Modifier.height(14.dp))
                Button(onClick = if (phase in setOf(ConnectionPhase.CONNECTED, ConnectionPhase.CONNECTING)) model::stopVpn else connect,
                    enabled = ui.activeServer != null && phase !in setOf(ConnectionPhase.STOPPING)) {
                    Icon(if (phase == ConnectionPhase.CONNECTED) Icons.Default.PowerSettingsNew else Icons.Default.VpnKey, null)
                    Spacer(Modifier.width(8.dp)); Text(if (phase in setOf(ConnectionPhase.CONNECTED, ConnectionPhase.CONNECTING)) "Отключить" else "Подключить")
                }
            } }
        }
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Автовыбор сервера", Modifier.weight(1f)); Switch(ui.snapshot.settings.automaticServer, model::setAutomatic)
            }
            OutlinedButton(model::measureServers, Modifier.fillMaxWidth()) { Icon(Icons.Default.Speed, null); Spacer(Modifier.width(8.dp)); Text("Проверить серверы") }
        }
        items(ui.activeSubscription?.servers.orEmpty(), key = { it.id }) { server ->
            ListItem(
                headlineContent = { Text(server.name) }, supportingContent = { Text("${server.protocol.uppercase()} · ${server.host}:${server.port}") },
                trailingContent = { Text(server.latencyMs?.let { "$it мс" } ?: "—") },
                leadingContent = { RadioButton(ui.snapshot.settings.selectedServerId == server.id, onClick = { model.selectServer(server.id) }) },
                modifier = Modifier.selectable(ui.snapshot.settings.selectedServerId == server.id) { model.selectServer(server.id) },
            )
        }
        if (ui.activeSubscription == null) item { Text("Добавьте подписку на вкладке «Настройки».") }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable private fun AppsScreen(ui: UiState, model: MainViewModel) {
    Column(Modifier.fillMaxSize()) {
        Text("Режим маршрутизации", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(16.dp, 12.dp))
        SingleChoiceSegmentedButtonRow(Modifier.padding(horizontal = 12.dp).fillMaxWidth()) {
            RoutingMode.entries.forEachIndexed { index, mode ->
                SegmentedButton(selected = ui.snapshot.settings.routingMode == mode, onClick = { model.setMode(mode) },
                    shape = SegmentedButtonDefaults.itemShape(index, RoutingMode.entries.size)) {
                    Text(when(mode) { RoutingMode.FULL -> "Все"; RoutingMode.SELECTED -> "Выбранные"; RoutingMode.BYPASS -> "Кроме" })
                }
            }
        }
        Text(if (ui.snapshot.settings.routingMode == RoutingMode.SELECTED) "Через VPN идут отмеченные приложения" else "Отмеченные приложения идут напрямую",
            Modifier.padding(16.dp), style = MaterialTheme.typography.bodySmall)
        LazyColumn(Modifier.weight(1f)) {
            items(ui.installedApps, key = { it.packageName }) { app ->
                ListItem(headlineContent = { Text(app.label) }, supportingContent = { Text(app.packageName) },
                    leadingContent = { Checkbox(app.packageName in ui.snapshot.settings.selectedPackages, { model.togglePackage(app.packageName) }) })
            }
        }
    }
}

@Composable private fun SettingsScreen(ui: UiState, model: MainViewModel) {
    var name by remember { mutableStateOf("") }
    var source by remember { mutableStateOf("") }
    var proxy by remember(ui.snapshot.settings.customProxy) { mutableStateOf(ui.snapshot.settings.customProxy.joinToString("\n")) }
    var direct by remember(ui.snapshot.settings.customDirect) { mutableStateOf(ui.snapshot.settings.customDirect.joinToString("\n")) }
    var block by remember(ui.snapshot.settings.customBlock) { mutableStateOf(ui.snapshot.settings.customBlock.joinToString("\n")) }
    LazyColumn(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item { Text("Подписки", style = MaterialTheme.typography.titleLarge) }
        items(ui.snapshot.subscriptions, key = { it.id }) { subscription ->
            ListItem(headlineContent = { Text(subscription.name) }, supportingContent = { Text("Серверов: ${subscription.servers.size}") },
                leadingContent = { RadioButton(subscription.id == ui.snapshot.settings.activeSubscriptionId, { model.selectSubscription(subscription.id) }) },
                trailingContent = { IconButton({ model.deleteSubscription(subscription.id) }) { Icon(Icons.Default.Delete, "Удалить") } })
        }
        item {
            OutlinedTextField(name, { name = it }, Modifier.fillMaxWidth(), label = { Text("Название") }, singleLine = true)
            OutlinedTextField(source, { source = it }, Modifier.fillMaxWidth(), label = { Text("HTTPS-ссылка или VLESS / Hysteria 2") }, minLines = 2, visualTransformation = PasswordVisualTransformation())
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button({ model.importSubscription(name, source); source = "" }, enabled = source.isNotBlank(), modifier = Modifier.weight(1f)) { Text("Добавить") }
                OutlinedButton(model::refreshSubscription, enabled = ui.activeSubscription != null, modifier = Modifier.weight(1f)) { Text("Обновить") }
            }
        }
        item { HorizontalDivider(); Text("Сеть", style = MaterialTheme.typography.titleLarge) }
        item { SettingSwitch("Российские сайты через VPN в полной защите", ui.snapshot.settings.russianSitesViaVpn, model::setRussianViaVpn) }
        item { SettingSwitch("IPv6 через VPN", ui.snapshot.settings.ipv6Enabled, model::setIpv6) }
        item { Text("Пользовательские маршруты", style = MaterialTheme.typography.titleMedium) }
        item { OutlinedTextField(proxy, { proxy = it }, Modifier.fillMaxWidth(), label = { Text("Через VPN") }, minLines = 2) }
        item { OutlinedTextField(direct, { direct = it }, Modifier.fillMaxWidth(), label = { Text("Напрямую") }, minLines = 2) }
        item { OutlinedTextField(block, { block = it }, Modifier.fillMaxWidth(), label = { Text("Блокировать") }, minLines = 2) }
        item { Button({ model.setRoutes(proxy, direct, block) }, Modifier.fillMaxWidth()) { Text("Сохранить маршруты") } }
        item { Text("Kill switch включается системной настройкой Android: VPN → Temple Tunnel → Постоянная VPN → Блокировать без VPN.", style = MaterialTheme.typography.bodySmall) }
    }
}

@Composable private fun SettingSwitch(label: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) { Text(label, Modifier.weight(1f)); Switch(checked, onChange) }
}
