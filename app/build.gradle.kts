import javax.inject.Inject

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
}

// The web portal at the repository root (the same files GitHub Pages serves) is
// the single source of truth. It is copied into every APK at build time, so the
// Android apps can never drift from the website. Do not add web files under
// app/src/main/assets.
abstract class SyncWebPortalTask : DefaultTask() {
    @get:InputFiles
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val webFiles: ConfigurableFileCollection

    @get:OutputDirectory
    abstract val outputDirectory: DirectoryProperty

    @get:Inject
    abstract val fileSystem: FileSystemOperations

    @TaskAction
    fun sync() {
        fileSystem.sync {
            from(webFiles)
            into(outputDirectory)
        }
    }
}

val webPortalFiles = rootProject.fileTree(rootProject.projectDir) {
    include("*.html", "*.js", "*.css", "manifest.json", "pwa-icon.png", "pwa-icon.svg")
}

android {
    namespace = "com.nexora.school"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.pulse.school"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    flavorDimensions += "portal"

    productFlavors {
        create("student") {
            dimension = "portal"
            applicationIdSuffix = ".student"
            manifestPlaceholders["appName"] = "NEXORA"
            manifestPlaceholders["portalTitle"] = "Student Portal"
            buildConfigField("String", "PORTAL_TYPE", "\"STUDENT\"")
            buildConfigField("String", "DEFAULT_URL", "\"file:///android_asset/index.html\"")
        }

        create("parent") {
            dimension = "portal"
            applicationIdSuffix = ".parent"
            manifestPlaceholders["appName"] = "NEXORA-P"
            manifestPlaceholders["portalTitle"] = "Parent Portal"
            buildConfigField("String", "PORTAL_TYPE", "\"PARENT\"")
            buildConfigField("String", "DEFAULT_URL", "\"file:///android_asset/parent.html\"")
        }

        create("teacher") {
            dimension = "portal"
            applicationIdSuffix = ".teacher"
            manifestPlaceholders["appName"] = "NEXORA-T"
            manifestPlaceholders["portalTitle"] = "Teacher Portal"
            buildConfigField("String", "PORTAL_TYPE", "\"TEACHER\"")
            buildConfigField("String", "DEFAULT_URL", "\"file:///android_asset/teacher.html\"")
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        buildConfig = true
        viewBinding = true
    }
}

androidComponents {
    onVariants { variant ->
        val taskName = "sync" + variant.name.replaceFirstChar { it.uppercase() } + "WebPortal"
        val syncWebPortal = tasks.register<SyncWebPortalTask>(taskName) {
            webFiles.from(webPortalFiles)
        }
        variant.sources.assets?.addGeneratedSourceDirectory(syncWebPortal, SyncWebPortalTask::outputDirectory)
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.appcompat)
    implementation(libs.material)
    implementation(libs.androidx.constraintlayout)
    implementation(libs.androidx.swiperefreshlayout)
    implementation(libs.androidx.webkit)
}
