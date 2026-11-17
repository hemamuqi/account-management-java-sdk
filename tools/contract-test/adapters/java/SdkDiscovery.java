package sdk.contract;

import java.io.File;
import java.lang.reflect.Modifier;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Stream;

final class SdkDiscovery {
    record Classes(Class<?> configuration, Class<?> client) {}

    private SdkDiscovery() {}

    static Classes find() throws Exception {
        String configuredClient = System.getenv("CONTRACT_JAVA_CLIENT_CLASS");
        String configuredConfiguration = System.getenv("CONTRACT_JAVA_CONFIG_CLASS");
        String directories = System.getenv("CONTRACT_SDK_CLASSES");
        if (directories == null || directories.isBlank()) {
            throw new IllegalArgumentException("CONTRACT_SDK_CLASSES must contain the SDK's compiled class directories");
        }
        List<Class<?>> configurations = new ArrayList<>();
        List<Class<?>> clients = new ArrayList<>();
        for (String directory : directories.split(java.util.regex.Pattern.quote(File.pathSeparator))) {
            Path root = Path.of(directory);
            if (!Files.isDirectory(root)) {
                throw new IllegalArgumentException("SDK class directory does not exist: " + root);
            }
            try (Stream<Path> files = Files.walk(root)) {
                for (Path file : files.filter(path -> path.toString().endsWith(".class")).toList()) {
                    String name = root.relativize(file).toString().replace(File.separatorChar, '.');
                    name = name.substring(0, name.length() - ".class".length());
                    if (name.contains("$") || name.contains(".generated.")) {
                        continue;
                    }
                    if (name.endsWith("Configuration") || name.equals(configuredConfiguration)) {
                        Class<?> type = Class.forName(name, false, SdkDiscovery.class.getClassLoader());
                        try {
                            if (Modifier.isStatic(type.getMethod("forLocalTesting", int.class).getModifiers())) {
                                type.getMethod("setAccessToken", String.class);
                                configurations.add(type);
                            }
                        } catch (NoSuchMethodException ignored) {
                            // Not an SDK test configuration.
                        }
                    } else if (name.endsWith("Client") || name.equals(configuredClient)) {
                        clients.add(Class.forName(name, false, SdkDiscovery.class.getClassLoader()));
                    }
                }
            }
        }
        List<Classes> matches = new ArrayList<>();
        for (Class<?> configuration : configurations) {
            if (configuredConfiguration != null && !configuredConfiguration.isBlank()
                    && !configuration.getName().equals(configuredConfiguration)) {
                continue;
            }
            for (Class<?> client : clients) {
                if (configuredClient != null && !configuredClient.isBlank()
                        && !client.getName().equals(configuredClient)) {
                    continue;
                }
                if (!AutoCloseable.class.isAssignableFrom(client)) {
                    continue;
                }
                try {
                    client.getConstructor(configuration);
                    matches.add(new Classes(configuration, client));
                } catch (NoSuchMethodException ignored) {
                    // This client does not use this configuration.
                }
            }
        }
        if (matches.size() != 1) {
                throw new IllegalStateException("Expected one SDK facade/configuration pair; found " + matches
                    + " (client=" + configuredClient + ", config=" + configuredConfiguration + ")");
        }
        return matches.get(0);
    }
}