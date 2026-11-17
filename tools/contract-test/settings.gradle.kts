pluginManagement {
    repositories {
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositories {
        mavenCentral()
    }
}

rootProject.name = "sdk-contract-test"
rootProject.buildFileName = "contract.gradle.kts"

include(":sdk")
project(":sdk").projectDir = file("../..")