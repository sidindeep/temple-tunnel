plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "local.templetunnel.android"
    compileSdk = 35

    defaultConfig {
        applicationId = "local.templetunnel.android"
        minSdk = 24
        targetSdk = 35
        versionCode = 14_01
        versionName = "0.14.1"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    val releaseStore = providers.environmentVariable("TEMPLE_ANDROID_KEYSTORE").orNull
    val releaseStorePassword = providers.environmentVariable("TEMPLE_ANDROID_STORE_PASSWORD").orNull
    val releaseKeyAlias = providers.environmentVariable("TEMPLE_ANDROID_KEY_ALIAS").orNull
    val releaseKeyPassword = providers.environmentVariable("TEMPLE_ANDROID_KEY_PASSWORD").orNull
    signingConfigs {
        if (releaseStore != null && releaseStorePassword != null && releaseKeyAlias != null && releaseKeyPassword != null) {
            create("release") {
                storeFile = file(releaseStore)
                storePassword = releaseStorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
            }
        }
    }
    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfigs.findByName("release")?.let { signingConfig = it }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { compose = true }
    packaging { jniLibs.useLegacyPackaging = true }
    sourceSets.named("main") {
        assets.srcDir("../../vendor/sing-box/rules")
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.12.01")
    implementation(composeBom)
    androidTestImplementation(composeBom)

    implementation("androidx.activity:activity-compose:1.10.0")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    debugImplementation("androidx.compose.ui:ui-tooling")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.security:security-crypto:1.1.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    implementation("net.clever-vpn:libbox-android:2.1.2")
    compileOnly("com.google.errorprone:error_prone_annotations:2.36.0")
    compileOnly("com.google.code.findbugs:jsr305:3.0.2")

    testImplementation("junit:junit:4.13.2")
    testImplementation(kotlin("test"))
    testImplementation("org.json:json:20240303")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
}
