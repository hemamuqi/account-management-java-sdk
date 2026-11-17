<?php

declare(strict_types=1);

use GuzzleHttp\Psr7\Utils;
use Microsoft\Kiota\Abstractions\ApiException;
use Microsoft\Kiota\Abstractions\Enum;
use Microsoft\Kiota\Abstractions\Serialization\Parsable;
use Microsoft\Kiota\Serialization\Json\JsonParseNodeFactory;

$composerLoader = require 'vendor/autoload.php';

function contractPath(string $name): string
{
    $path = getenv($name);
    if ($path === false || $path === '') {
        throw new RuntimeException("Missing $name");
    }
    return $path;
}

/** @return array{string, string} */
function discoverSdk(Composer\Autoload\ClassLoader $loader, string $tokenArgument, array $paths): array
{
    $configuredClient = getenv('CONTRACT_PHP_CLIENT_CLASS') ?: null;
    $configuredConfig = getenv('CONTRACT_PHP_CONFIG_CLASS') ?: null;
    if ($configuredClient !== null && !class_exists($configuredClient)) {
        throw new RuntimeException("SDK client class not found: $configuredClient");
    }
    if ($configuredConfig !== null && !class_exists($configuredConfig)) {
        throw new RuntimeException("SDK configuration class not found: $configuredConfig");
    }
    $classes = [];
    foreach ($loader->getPrefixesPsr4() as $namespace => $directories) {
        foreach ($directories as $directory) {
            $real = realpath($directory);
            $root = realpath(getcwd());
            if ($real === false || $root === false || !str_starts_with($real, $root . DIRECTORY_SEPARATOR)
                || str_starts_with($real, $root . DIRECTORY_SEPARATOR . 'vendor' . DIRECTORY_SEPARATOR)) {
                continue;
            }
            $files = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($real));
            foreach ($files as $file) {
                if (!$file->isFile() || !preg_match('/(?:Client|Configuration)\.php$/', $file->getFilename())
                    || str_contains($file->getPathname(), DIRECTORY_SEPARATOR . 'Generated' . DIRECTORY_SEPARATOR)) {
                    continue;
                }
                $relative = substr($file->getPathname(), strlen($real) + 1);
                $class = $namespace . str_replace(DIRECTORY_SEPARATOR, '\\', substr($relative, 0, -4));
                if (class_exists($class)) {
                    $classes[$class] = true;
                }
            }
        }
    }
    if ($configuredClient !== null) $classes[$configuredClient] = true;
    if ($configuredConfig !== null) $classes[$configuredConfig] = true;
    $matches = [];
    foreach (array_keys($classes) as $configClass) {
        if ($configuredConfig !== null && $configClass !== $configuredConfig) continue;
        $constructor = (new ReflectionClass($configClass))->getConstructor();
        if ($constructor === null) continue;
        $names = array_map(static fn(ReflectionParameter $parameter): string => $parameter->getName(), $constructor->getParameters());
        if (!in_array($tokenArgument, $names, true) || array_diff(array_keys($paths), $names)) continue;
        foreach (array_keys($classes) as $clientClass) {
            if ($configuredClient !== null && $clientClass !== $configuredClient) continue;
            $clientConstructor = (new ReflectionClass($clientClass))->getConstructor();
            $parameters = $clientConstructor?->getParameters();
            if ($parameters === null || $parameters === [] || $clientConstructor->getNumberOfRequiredParameters() !== 1) continue;
            $type = $parameters[0]->getType();
            if ($type instanceof ReflectionNamedType && !$type->isBuiltin() && $type->getName() === $configClass) {
                $matches[] = [$clientClass, $configClass];
            }
        }
    }
    if (count($matches) !== 1) {
        throw new RuntimeException('Expected one SDK facade/configuration pair; found ' . json_encode($matches)
            . "; specify client-class and config-class to disambiguate");
    }
    return $matches[0];
}

function openSdk(Composer\Autoload\ClassLoader $loader, int $port): object
{
    $overrides = json_decode(getenv('CONTRACT_PHP_BASE_URLS') ?: '{}', false, 512, JSON_THROW_ON_ERROR);
    if (!is_object($overrides)) {
        throw new RuntimeException('CONTRACT_PHP_BASE_URLS must be a JSON object of constructor arguments to URL paths');
    }
    $paths = (array) $overrides;
    $tokenArgument = getenv('CONTRACT_PHP_TOKEN_ARGUMENT') ?: 'accessToken';
    [$clientClass, $configClass] = discoverSdk($loader, $tokenArgument, $paths);
    $constructor = (new ReflectionClass($configClass))->getConstructor();
    if ($constructor === null) {
        throw new RuntimeException("Configuration has no constructor: $configClass");
    }
    if (array_key_exists($tokenArgument, $paths)) {
        throw new RuntimeException("Token argument overlaps a base URL: $tokenArgument");
    }
    $arguments = [$tokenArgument => 'contract-token'];
    foreach ($constructor->getParameters() as $parameter) {
        $name = $parameter->getName();
        if (stripos($name, 'baseUrl') === false) continue;
        if (array_key_exists($name, $paths)) {
            $path = $paths[$name];
            if (!is_string($path) || !str_starts_with($path, '/') || str_starts_with($path, '//')
                || strpbrk($path, '?#') !== false) {
                throw new RuntimeException("Invalid mock base path: $name");
            }
        } else {
            if (!$parameter->isDefaultValueAvailable()) {
                throw new RuntimeException("Base URL has no default: $name; configure base-urls");
            }
            $url = $parameter->getDefaultValue();
            $parts = is_string($url) ? parse_url($url) : false;
            if (!is_array($parts) || !in_array(strtolower($parts['scheme'] ?? ''), ['http', 'https'], true)
                || empty($parts['host']) || isset($parts['user']) || isset($parts['pass'])
                || isset($parts['query']) || isset($parts['fragment'])) {
                throw new RuntimeException("Invalid default base URL: $name; configure base-urls");
            }
            $path = $parts['path'] ?? '/';
        }
        $arguments[$name] = "http://127.0.0.1:$port$path";
    }
    $config = (new ReflectionClass($configClass))->newInstanceArgs($arguments);
    return (new ReflectionClass($clientClass))->newInstance($config);
}

function decoded(mixed $value): mixed
{
    if ($value instanceof Parsable) {
        $result = [];
        foreach (array_keys($value->getFieldDeserializers()) as $field) {
            $getter = 'get' . ucfirst($field);
            if (method_exists($value, $getter)) {
                $fieldValue = $value->$getter();
                if ($fieldValue !== null) {
                    $result[$field] = decoded($fieldValue);
                }
            }
        }
        if (method_exists($value, 'getAdditionalData')) {
            $result = array_merge($result, $value->getAdditionalData() ?? []);
        }
        return (object) $result;
    }
    if ($value instanceof Enum) {
        return $value->value();
    }
    if ($value instanceof DateTimeInterface) {
        return $value->format('Y-m-d\TH:i:sP');
    }
    if (is_array($value)) {
        return array_map(decoded(...), $value);
    }
    return $value;
}

function keyFor(string $name): string
{
    return strtolower(preg_replace('/[^a-zA-Z0-9]/', '', $name) ?? '');
}

function findClient(object $sdk, string $surface, string $operationId): object
{
    $matches = [];
    foreach (get_object_vars($sdk) as $name => $client) {
        if (is_object($client) && method_exists($client, $operationId)) {
            $matches[$name] = $client;
        }
    }
    foreach (get_class_methods($sdk) as $getter) {
        if (!str_starts_with($getter, 'get')) {
            continue;
        }
        $accessor = new ReflectionMethod($sdk, $getter);
        if ($accessor->getNumberOfRequiredParameters() !== 0 || $accessor->getNumberOfParameters() !== 0) {
            continue;
        }
        $name = lcfirst(substr($getter, 3));
        if (isset($matches[$name])) {
            continue;
        }
        $client = $accessor->invoke($sdk);
        if (is_object($client) && method_exists($client, $operationId)) {
            $matches[$name] = $client;
        }
    }
    $preferred = array_filter($matches, static fn(string $name): bool => keyFor($name) === keyFor($surface), ARRAY_FILTER_USE_KEY);
    $selected = $preferred ?: $matches;
    if (count($selected) !== 1) {
        throw new RuntimeException("Expected one SDK client for $surface:$operationId; found " . implode(', ', array_keys($selected)));
    }
    return reset($selected);
}

/** @param array<string, mixed> $case */
function requestOptions(ReflectionMethod $method, array $case): object
{
    foreach ($method->getParameters() as $parameter) {
        if ($parameter->getName() !== 'requestOptions') {
            continue;
        }
        $type = $parameter->getType();
        if (!$type instanceof ReflectionNamedType || $type->isBuiltin()) {
            break;
        }
        $class = $type->getName();
        $options = new $class();
        $headers = ['X-Contract-Case-Id' => $case['id']];
        foreach ($case['parameters'] as $specParameter) {
            if ($specParameter['in'] === 'header' && !in_array(strtolower($specParameter['name']), ['content-type', 'accept'], true)) {
                $headers[$specParameter['name']] = (string) $specParameter['value'];
            }
        }
        foreach ($headers as $name => $value) {
            if (method_exists($options, 'addHeader')) {
                $options->addHeader($name, $value);
            } elseif (property_exists($options, 'headers') && is_array($options->headers)) {
                $options->headers[$name] = $value;
            } else {
                throw new RuntimeException("Request options cannot set headers: $class");
            }
        }
        return $options;
    }
    throw new RuntimeException("SDK method has no typed requestOptions: {$method->getName()}");
}

/**
 * @param array<string, mixed> $case
 * @return array<int, mixed>
 */
function arguments(ReflectionMethod $method, array $case): array
{
    $options = requestOptions($method, $case);
    $parameters = [];
    foreach ($case['parameters'] as $parameter) {
        if ($parameter['in'] !== 'header') {
            $parameters[keyFor($parameter['name'])] = $parameter;
        }
    }
    $values = [];
    foreach ($method->getParameters() as $parameter) {
        $name = $parameter->getName();
        $key = keyFor($name);
        if ($name === 'accessToken') {
            $values[] = null;
        } elseif ($name === 'requestOptions') {
            $values[] = $options;
        } elseif ($name === 'body') {
            if (!$case['hasRequestBody']) {
                throw new RuntimeException("SDK parameter not found in OpenAPI request: $name");
            }
            $type = $parameter->getType();
            if (!$type instanceof ReflectionNamedType || $type->isBuiltin()) {
                throw new RuntimeException("Unsupported request body type: $name");
            }
            $model = $type->getName();
            if (!is_a($model, Parsable::class, true)) {
                throw new RuntimeException("Request body is not a Kiota model: $model");
            }
            $node = (new JsonParseNodeFactory())->getRootParseNode(
                'application/json',
                Utils::streamFor(json_encode($case['body'], JSON_THROW_ON_ERROR))
            );
            $values[] = $node->getObjectValue([$model, 'createFromDiscriminatorValue']);
        } elseif (isset($parameters[$key])) {
            $values[] = $parameters[$key]['value'];
            unset($parameters[$key]);
        } elseif ($parameter->isDefaultValueAvailable()) {
            $values[] = $parameter->getDefaultValue();
        } else {
            throw new RuntimeException("SDK parameter not found in OpenAPI request: $name");
        }
    }
    if ($parameters !== []) {
        throw new RuntimeException('Unmapped spec parameters: ' . implode(', ', array_column($parameters, 'name')));
    }
    return $values;
}

$contents = file_get_contents(contractPath('CONTRACT_CASES'));
if ($contents === false) {
    throw new RuntimeException('Cannot read contract cases');
}
$manifest = json_decode($contents, true, 512, JSON_THROW_ON_ERROR);
$sdk = openSdk($composerLoader, $manifest['port']);
$results = [];
foreach ($manifest['cases'] as $case) {
    try {
        $surface = explode(':', $case['id'], 2)[0];
        $client = findClient($sdk, $surface, $case['operationId']);
        $method = new ReflectionMethod($client, $case['operationId']);
        $response = $method->invokeArgs($client, arguments($method, $case));
        $results[] = ['response' => decoded($response)];
    } catch (Throwable $error) {
        if ($case['status'] >= 400 && $error instanceof ApiException && $error->getResponseStatusCode() !== null) {
            $results[] = ['status' => $error->getResponseStatusCode(), 'response' => $error instanceof Parsable ? decoded($error) : null];
        } else {
            $results[] = ['error' => $error->getMessage()];
        }
    }
}
file_put_contents(contractPath('CONTRACT_RESULTS'), json_encode($results, JSON_THROW_ON_ERROR));