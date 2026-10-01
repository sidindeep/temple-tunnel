package local.templetunnel.android.vpn

import android.util.Log
import kotlinx.coroutines.flow.MutableStateFlow
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** A small, in-memory, redacted event log. It never records subscription URLs or profiles. */
object DiagnosticLog {
    val entries = MutableStateFlow<List<String>>(emptyList())

    @Synchronized fun record(event: String) {
        val timestamp = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.ROOT).format(Date())
        entries.value = (entries.value + "$timestamp  $event").takeLast(120)
        Log.i("TempleTunnel", event)
    }

    fun exportText(): String = buildString {
        appendLine("Temple Tunnel Android — connection events")
        entries.value.forEach(::appendLine)
    }
}
