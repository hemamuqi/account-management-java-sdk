import org.gradle.api.tasks.SourceSetContainer

plugins {
    java
}

java {
    toolchain { languageVersion.set(JavaLanguageVersion.of(17)) }
}

sourceSets.main {
    java.setSrcDirs(listOf("adapters/java/src"))
}

evaluationDependsOn(":sdk")
val sdkMain = project(":sdk").extensions.getByType<SourceSetContainer>().getByName("main")

tasks.named<JavaCompile>("compileJava") {
    classpath = sdkMain.runtimeClasspath
}

tasks.register<JavaExec>("contractTestAdapter") {
    group = "verification"
    description = "Runs the configurable Java SDK adapter for the language-neutral contract runner."
    dependsOn(tasks.named("classes"))
    classpath = sourceSets.main.get().runtimeClasspath + sdkMain.runtimeClasspath
    mainClass.set("sdk.contract.ContractAdapter")
    environment("CONTRACT_SDK_CLASSES", sdkMain.output.classesDirs.asPath)
}