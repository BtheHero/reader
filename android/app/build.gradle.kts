plugins {
    id("com.android.application")
}

// Set by the GitHub Actions workflow: the build number, and the signing key from the repository's secrets
val buildNumber = (System.getenv("VERSION_CODE") ?: "1").toInt()
val keystoreFile: String? = System.getenv("KEYSTORE_FILE")

android {
    namespace = "com.ilyasbt.reader"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.ilyasbt.reader"
        minSdk = 26
        targetSdk = 35
        versionCode = buildNumber
        versionName = "1.0.$buildNumber"
    }

    signingConfigs {
        create("release") {
            if (keystoreFile != null) {
                storeFile = file(keystoreFile)
                storePassword = System.getenv("KEYSTORE_PASSWORD")
                keyAlias = "reader"
                keyPassword = System.getenv("KEYSTORE_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // Without the secret, fall back to a throwaway key (each such build needs uninstalling the previous one)
            signingConfig = if (keystoreFile != null) signingConfigs.getByName("release") else signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation("androidx.core:core:1.13.1")
    implementation("androidx.activity:activity:1.9.3")
    // AndroidX brings Kotlin's standard library in two versions; line them up on one
    implementation(platform("org.jetbrains.kotlin:kotlin-bom:1.8.22"))
}
