package local.templetunnel.android

import android.app.Application
import io.nekohasekai.libbox.Libbox
import io.nekohasekai.libbox.SetupOptions
import local.templetunnel.android.data.TempleRepository

class TempleApplication : Application() {
    val repository by lazy { TempleRepository(this) }

    override fun onCreate() {
        super.onCreate()
        Libbox.setup(SetupOptions().apply {
            basePath = filesDir.absolutePath
            workingPath = filesDir.absolutePath
            tempPath = cacheDir.absolutePath
            fixAndroidStack = true
            commandServerListenPort = 0
            logMaxLines = 300
        })
        Libbox.setMemoryLimit(true)
    }
}
