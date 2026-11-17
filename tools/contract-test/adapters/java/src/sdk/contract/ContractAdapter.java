package sdk.contract;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.google.gson.JsonParser;
import com.microsoft.kiota.ApiException;
import com.microsoft.kiota.serialization.AdditionalDataHolder;
import com.microsoft.kiota.serialization.JsonParseNode;
import com.microsoft.kiota.serialization.JsonSerializationWriter;
import com.microsoft.kiota.serialization.Parsable;
import java.lang.reflect.Field;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Parameter;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;

public final class ContractAdapter {
    private static final ObjectMapper JSON = new ObjectMapper();
    private record Target(String name, Object client, Method method) {}

    private ContractAdapter() {}

    public static void main(String[] args) throws Exception {
        JsonNode manifest = JSON.readTree(Path.of(System.getenv("CONTRACT_CASES")).toFile());
        ArrayNode results = JSON.createArrayNode();
        SdkDiscovery.Classes sdkClasses = SdkDiscovery.find();
        Class<?> configurationClass = sdkClasses.configuration();
        Object config = configurationClass.getMethod("forLocalTesting", int.class)
            .invoke(null, manifest.get("port").asInt());
        configurationClass.getMethod("setAccessToken", String.class)
            .invoke(config, "contract-token");
        Class<?> clientClass = sdkClasses.client();
        try (AutoCloseable sdk = (AutoCloseable) clientClass.getConstructor(configurationClass).newInstance(config)) {
            for (JsonNode testCase : manifest.get("cases")) {
                ObjectNode result = JSON.createObjectNode();
                try {
                    String surface = testCase.get("id").asText().split(":", 2)[0];
                    String operationId = testCase.get("operationId").asText();
                    Target target = findTarget(sdk, surface, operationId + "Async");
                    Object[] parameters = arguments(target.method(), testCase);
                    Object response = ((CompletableFuture<?>) target.method().invoke(target.client(), parameters)).join();
                    result.set("response", response == null ? JSON.nullNode() : serialize(response));
                } catch (Exception error) {
                    Throwable cause = error;
                    while ((cause instanceof InvocationTargetException || cause instanceof CompletionException)
                            && cause.getCause() != null) {
                        cause = cause.getCause();
                    }
                    if (testCase.get("status").asInt() >= 400 && cause instanceof ApiException apiError) {
                        result.put("status", apiError.getResponseStatusCode());
                        if (apiError instanceof Parsable model) {
                            result.set("response", serialize(model));
                        }
                    } else {
                        result.put("error", cause.toString());
                    }
                }
                results.add(result);
            }
        }
        Files.writeString(Path.of(System.getenv("CONTRACT_RESULTS")), JSON.writeValueAsString(results));
    }

    private static Method findMethod(Class<?> type, String name) {
        Method found = null;
        for (Method method : type.getMethods()) {
            if (method.getName().equals(name) && CompletableFuture.class.isAssignableFrom(method.getReturnType())) {
                if (found != null) {
                    throw new IllegalArgumentException("Ambiguous SDK method: " + type.getName() + "." + name);
                }
                found = method;
            }
        }
        return found;
    }

    private static String key(String name) {
        return name.replaceAll("[^A-Za-z0-9]", "").toLowerCase(java.util.Locale.ROOT);
    }

    private static Target findTarget(Object sdk, String surface, String methodName) throws Exception {
        List<Target> matches = new ArrayList<>();
        for (Field field : sdk.getClass().getFields()) {
            Method method = findMethod(field.getType(), methodName);
            if (method != null) {
                matches.add(new Target(key(field.getName()), field.get(sdk), method));
            }
        }
        for (Method accessor : sdk.getClass().getMethods()) {
            if (!accessor.getName().startsWith("get") || accessor.getParameterCount() != 0) {
                continue;
            }
            Method method = findMethod(accessor.getReturnType(), methodName);
            if (method != null) {
                String name = key(accessor.getName().substring(3));
                if (matches.stream().noneMatch(match -> match.name().equals(name) && match.method().equals(method))) {
                    matches.add(new Target(name, accessor.invoke(sdk), method));
                }
            }
        }
        List<Target> preferred = matches.stream().filter(target -> target.name().equals(key(surface))).toList();
        List<Target> selected = preferred.isEmpty() ? matches : preferred;
        if (selected.size() != 1) {
            throw new IllegalArgumentException("Expected one SDK method for " + surface + ":" + methodName
                + "; found " + selected.stream().map(Target::name).toList());
        }
        return selected.get(0);
    }

    private static Object[] arguments(Method method, JsonNode testCase) throws Exception {
        Map<String, JsonNode> specParameters = new HashMap<>();
        Map<String, String> headerNames = new HashMap<>();
        for (JsonNode parameter : testCase.get("parameters")) {
            String name = parameter.get("name").asText();
            specParameters.put(key(name), parameter.get("value"));
            if (parameter.get("in").asText().equals("header")) {
                headerNames.put(key(name), name);
            }
        }
        List<Object> values = new ArrayList<>();
        Class<?> requestOptionsClass = null;
        for (Parameter parameter : method.getParameters()) {
            if (parameter.getName().equals("requestOptions")) {
                requestOptionsClass = parameter.getType();
            }
        }
        if (requestOptionsClass == null) {
            throw new IllegalArgumentException("SDK method has no requestOptions parameter: " + method);
        }
        Object options = requestOptionsClass.getConstructor().newInstance();
        Method addHeader = requestOptionsClass.getMethod("addHeader", String.class, String.class);
        addHeader.invoke(options, "X-Contract-Case-Id", testCase.get("id").asText());
        for (Parameter parameter : method.getParameters()) {
            String name = parameter.getName();
            Class<?> type = parameter.getType();
            if (name.equals("accessToken")) {
                values.add(null);
            } else if (type == requestOptionsClass) {
                values.add(options);
            } else if (name.equals("body")) {
                if (testCase.get("body").isNull()) {
                    throw new IllegalArgumentException("Missing request body for " + method.getName());
                }
                Method factory = type.getMethod("createFromDiscriminatorValue", com.microsoft.kiota.serialization.ParseNode.class);
                var node = new JsonParseNode(JsonParser.parseString(testCase.get("body").toString()));
                Parsable body = node.getObjectValue(parseNode -> {
                    try {
                        return (Parsable) factory.invoke(null, parseNode);
                    } catch (ReflectiveOperationException error) {
                        throw new IllegalArgumentException(error);
                    }
                });
                validateRequestFields(body);
                values.add(body);
            } else {
                JsonNode value = specParameters.remove(key(name));
                if (value == null) {
                    throw new IllegalArgumentException("Spec parameter missing for " + method.getName() + "." + name);
                }
                if (type == String.class) {
                    values.add(value.asText());
                } else if (type == Integer.class) {
                    values.add(value.asInt());
                } else if (type == String[].class) {
                    List<String> items = new ArrayList<>();
                    if (value.isArray()) {
                        value.forEach(item -> items.add(item.asText()));
                    } else {
                        items.add(value.asText());
                    }
                    values.add(items.toArray(String[]::new));
                } else {
                    throw new IllegalArgumentException("Unsupported SDK parameter type: " + type);
                }
            }
        }
        for (String name : headerNames.values()) {
            JsonNode value = specParameters.remove(key(name));
            if (value != null) {
                addHeader.invoke(options, name, value.asText());
            }
        }
        if (!specParameters.isEmpty()) {
            throw new IllegalArgumentException("Unmapped spec parameters: " + specParameters.keySet());
        }
        return values.toArray();
    }

    private static void validateRequestFields(Parsable body) throws Exception {
        try (var writer = new JsonSerializationWriter()) {
            writer.setOnBeforeObjectSerialization(value -> {
                if (value instanceof AdditionalDataHolder holder && !holder.getAdditionalData().isEmpty()) {
                    throw new IllegalArgumentException("Request fields missing from SDK model "
                        + value.getClass().getName() + ": " + holder.getAdditionalData().keySet());
                }
            });
            writer.writeObjectValue(null, body);
        }
    }

    private static JsonNode serialize(Object response) throws Exception {
        if (!(response instanceof Parsable model)) {
            throw new IllegalArgumentException("Unexpected SDK response type: " + response.getClass());
        }
        try (var writer = new JsonSerializationWriter()) {
            writer.setOnBeforeObjectSerialization(value -> {
                if (value instanceof AdditionalDataHolder holder) {
                    holder.getAdditionalData().clear();
                }
            });
            writer.writeObjectValue(null, model);
            return JSON.readTree(writer.getSerializedContent());
        }
    }
}