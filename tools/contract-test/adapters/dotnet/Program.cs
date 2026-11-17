using System.Collections;
using System.Reflection;
using System.Text.Json;
using Microsoft.Kiota.Abstractions;
using Microsoft.Kiota.Abstractions.Serialization;
using Microsoft.Kiota.Serialization.Json;

static string Required(string name) => Environment.GetEnvironmentVariable(name)
    is { Length: > 0 } value ? value : throw new InvalidOperationException($"Missing {name}");

using var manifest = JsonDocument.Parse(await File.ReadAllTextAsync(Required("CONTRACT_CASES")));
var port = manifest.RootElement.GetProperty("port").GetInt32();
using var paths = JsonDocument.Parse(Environment.GetEnvironmentVariable("CONTRACT_DOTNET_BASE_URLS") is { Length: > 0 } configuredPaths
    ? configuredPaths : "{}");
if (paths.RootElement.ValueKind != JsonValueKind.Object)
    throw new InvalidOperationException("CONTRACT_DOTNET_BASE_URLS must be a JSON object");
var configuredAssembly = Environment.GetEnvironmentVariable("CONTRACT_DOTNET_ASSEMBLY");
var assemblies = configuredAssembly is { Length: > 0 }
    ? new[] { Assembly.Load(configuredAssembly) }
    : Directory.GetFiles(AppContext.BaseDirectory, "*.dll")
        .Select(Assembly.LoadFrom).ToArray();
var configuredClient = Environment.GetEnvironmentVariable("CONTRACT_DOTNET_CLIENT_CLASS");
var configuredConfig = Environment.GetEnvironmentVariable("CONTRACT_DOTNET_CONFIG_CLASS");
var tokenName = Environment.GetEnvironmentVariable("CONTRACT_DOTNET_TOKEN_PROPERTY") ?? "AccessToken";
var types = assemblies.SelectMany(assembly => assembly.GetExportedTypes())
    .Where(type => type.IsClass && !type.IsAbstract && type.Namespace?.Contains(".Generated", StringComparison.OrdinalIgnoreCase) != true).ToArray();
var pairs = (from configuration in types
    where (configuredConfig is { Length: > 0 } ? configuration.FullName == configuredConfig : configuration.Name.EndsWith("Configuration", StringComparison.Ordinal))
        && configuration.GetConstructor(Type.EmptyTypes) != null
        && configuration.GetProperty(tokenName)?.CanWrite == true
        && paths.RootElement.EnumerateObject().All(entry => configuration.GetProperty(entry.Name)?.CanWrite == true)
    from client in types
    where (configuredClient is { Length: > 0 } ? client.FullName == configuredClient : client.Name.EndsWith("Client", StringComparison.Ordinal))
        && client.GetConstructor(new[] { configuration, typeof(HttpMessageHandler) }) != null
    select (configuration, client)).ToArray();
if (pairs.Length != 1)
    throw new InvalidOperationException($"Expected one SDK facade/configuration pair, found {pairs.Length}; " +
        "set CONTRACT_DOTNET_ASSEMBLY, CONTRACT_DOTNET_CLIENT_CLASS and CONTRACT_DOTNET_CONFIG_CLASS to disambiguate");
var (configType, clientType) = pairs[0];
var config = Activator.CreateInstance(configType) ?? throw new InvalidOperationException("Cannot create SDK configuration");
var configured = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
foreach (var property in configType.GetProperties(BindingFlags.Public | BindingFlags.Instance))
{
    if (!property.Name.Contains("BaseUrl", StringComparison.OrdinalIgnoreCase)) continue;
    if (property.PropertyType != typeof(string) || !property.CanRead || !property.CanWrite || property.GetIndexParameters().Length != 0)
        throw new InvalidOperationException($"Unsupported base URL property: {property.Name}");
    string path;
    if (paths.RootElement.TryGetProperty(property.Name, out var overridePath))
    {
        path = overridePath.GetString() ?? throw new InvalidOperationException($"Invalid mock base path: {property.Name}");
    }
    else
    {
        var value = property.GetValue(config) as string;
        if (!Uri.TryCreate(value, UriKind.Absolute, out var defaultUrl) ||
            (defaultUrl.Scheme != "https" && defaultUrl.Scheme != "http") ||
            string.IsNullOrEmpty(defaultUrl.Host) || !string.IsNullOrEmpty(defaultUrl.UserInfo) ||
            !string.IsNullOrEmpty(defaultUrl.Query) || !string.IsNullOrEmpty(defaultUrl.Fragment))
            throw new InvalidOperationException($"Invalid default base URL: {property.Name}; configure base-urls");
        path = defaultUrl.AbsolutePath;
    }
    if (!path.StartsWith('/') || path.StartsWith("//", StringComparison.Ordinal) || path.Contains('?') || path.Contains('#'))
        throw new InvalidOperationException($"Invalid mock base path: {property.Name}");
    property.SetValue(config, $"https://127.0.0.1:{port}{path}");
    configured.Add(property.Name);
}
foreach (var entry in paths.RootElement.EnumerateObject())
{
    if (configured.Contains(entry.Name)) continue;
    var path = entry.Value.GetString();
    if (path is null || !path.StartsWith('/') || path.StartsWith("//", StringComparison.Ordinal) || path.Contains('?') || path.Contains('#'))
        throw new InvalidOperationException($"Invalid mock base path: {entry.Name}");
    var property = configType.GetProperty(entry.Name, BindingFlags.Public | BindingFlags.Instance)
        ?? throw new InvalidOperationException($"Missing configuration property: {entry.Name}");
    property.SetValue(config, $"https://127.0.0.1:{port}{path}");
    configured.Add(property.Name);
}
var tokenProperty = configType.GetProperty(tokenName)
    ?? throw new InvalidOperationException("SDK configuration has no token property");
tokenProperty.SetValue(config, "contract-token");
if (configType.GetProperty("AllowedHosts")?.GetValue(config) is IList hosts) hosts.Add("127.0.0.1");
using var handler = new LoopbackHandler(port);
var sdk = Activator.CreateInstance(clientType, config, handler)
    ?? throw new InvalidOperationException("SDK must have a public (configuration, HttpMessageHandler) constructor");
try
{
    var results = new List<object>();
    foreach (var testCase in manifest.RootElement.GetProperty("cases").EnumerateArray())
    {
        try
        {
            var surface = testCase.GetProperty("id").GetString()!.Split(':')[0];
            var operationId = testCase.GetProperty("operationId").GetString()!;
            var name = char.ToUpperInvariant(operationId[0]) + operationId[1..] + "Async";
            var matches = clientType.GetProperties(BindingFlags.Public | BindingFlags.Instance)
                .Where(property => property.GetIndexParameters().Length == 0)
                .Select(property => (property.Name, Client: property.GetValue(sdk)))
                .Where(item => item.Client?.GetType().GetMethod(name) != null).ToArray();
            var preferred = matches.Where(item => Key(item.Name) == Key(surface)).ToArray();
            var candidates = preferred.Length > 0 ? preferred : matches;
            if (candidates.Length != 1)
                throw new InvalidOperationException($"Expected one SDK client for {surface}:{name}, found {candidates.Length}");
            var client = candidates[0].Client!;
            var methods = client.GetType().GetMethods().Where(method => method.Name == name).ToArray();
            if (methods.Length != 1) throw new InvalidOperationException($"Expected one SDK method for {name}, found {methods.Length}");
            var task = (Task)methods[0].Invoke(client, Bind(methods[0], testCase))!;
            await task;
            var response = task.GetType().IsGenericType ? task.GetType().GetProperty("Result")!.GetValue(task) : null;
            results.Add(new { response = Serialize(response) });
        }
        catch (Exception exception)
        {
            var error = exception is TargetInvocationException invocation && invocation.InnerException != null
                ? invocation.InnerException : exception;
            var apiError = error as ApiException ?? error.InnerException as ApiException;
            if (apiError != null && testCase.GetProperty("status").GetInt32() >= 400)
                results.Add(new { status = apiError.ResponseStatusCode, response = Serialize(apiError as IParsable) });
            else results.Add(new { error = error.ToString() });
        }
    }
    await File.WriteAllTextAsync(Required("CONTRACT_RESULTS"), JsonSerializer.Serialize(results));
}
finally { (sdk as IDisposable)?.Dispose(); }

static object?[] Bind(MethodInfo method, JsonElement testCase)
{
    var parameters = testCase.GetProperty("parameters").EnumerateArray().ToArray();
    var used = new HashSet<int>();
    var optionsParameter = method.GetParameters().SingleOrDefault(parameter => parameter.Name == "requestOptions");
    var options = Activator.CreateInstance(optionsParameter?.ParameterType
        ?? throw new InvalidOperationException($"{method.Name} has no requestOptions"))!;
    void AddHeader(string name, string value)
    {
        var headers = options.GetType().GetProperty("Headers")?.GetValue(options);
        if (headers is IDictionary<string, string> dictionary) dictionary[name] = value;
        else if (options.GetType().GetMethod("AddHeader", new[] { typeof(string), typeof(string) }) is { } add)
            add.Invoke(options, new object[] { name, value });
        else throw new InvalidOperationException("RequestOptions must expose Headers or AddHeader");
    }
    AddHeader("X-Contract-Case-Id", testCase.GetProperty("id").GetString()!);
    var values = new List<object?>();
    foreach (var parameter in method.GetParameters())
    {
        if (parameter.Name == "accessToken") { values.Add(null); continue; }
        if (parameter.ParameterType == typeof(CancellationToken)) { values.Add(CancellationToken.None); continue; }
        if (parameter == optionsParameter) { values.Add(options); continue; }
        if (parameter.Name == "body")
        {
            if (!testCase.GetProperty("hasRequestBody").GetBoolean())
                throw new InvalidOperationException($"Undeclared body on {method.Name}");
            var body = testCase.GetProperty("body");
            values.Add(body.ValueKind == JsonValueKind.Null ? null : ParseBody(parameter.ParameterType, body));
            continue;
        }
        var requestBody = testCase.GetProperty("body");
        if (parameter.Name == "fileContent" && requestBody.ValueKind == JsonValueKind.Object &&
            requestBody.TryGetProperty("dataBase64", out var base64))
        { values.Add(new MemoryStream(Convert.FromBase64String(base64.GetString()!))); continue; }
        if (parameter.Name == "fileName" && requestBody.ValueKind == JsonValueKind.Object)
        { values.Add("contract-upload.bin"); continue; }
        var index = Array.FindIndex(parameters, item =>
            Key(item.GetProperty("name").GetString()!) == Key(parameter.Name!));
        if (index >= 0) { used.Add(index); values.Add(ConvertValue(parameters[index].GetProperty("value"), parameter.ParameterType)); }
        else if (parameter.HasDefaultValue) values.Add(parameter.DefaultValue);
        else throw new InvalidOperationException($"Unbound SDK parameter {method.Name}.{parameter.Name}");
    }
    for (var index = 0; index < parameters.Length; index++)
    {
        if (used.Contains(index)) continue;
        var item = parameters[index];
        if (item.GetProperty("in").GetString() != "header")
            throw new InvalidOperationException($"Unbound spec parameter {item.GetProperty("name")}");
        var name = item.GetProperty("name").GetString()!;
        if (!name.Equals("Content-Type", StringComparison.OrdinalIgnoreCase) &&
            !name.Equals("Accept", StringComparison.OrdinalIgnoreCase))
            AddHeader(name, item.GetProperty("value").ToString());
    }
    return values.ToArray();
}

static object? ConvertValue(JsonElement value, Type type)
{
    if (value.ValueKind == JsonValueKind.Null) return null;
    var target = Nullable.GetUnderlyingType(type) ?? type;
    if (target == typeof(string)) return value.ToString();
    if (target == typeof(int)) return value.GetInt32();
    if (target == typeof(string[])) return value.ValueKind == JsonValueKind.Array
        ? value.EnumerateArray().Select(item => item.ToString()).ToArray() : new[] { value.ToString() };
    throw new InvalidOperationException($"Unsupported SDK argument type {type}");
}

static object? ParseBody(Type type, JsonElement body)
{
    if (type == typeof(byte[])) return Convert.FromBase64String(body.GetProperty("dataBase64").GetString()!);
    if (!typeof(IParsable).IsAssignableFrom(type)) throw new InvalidOperationException($"Unsupported body type {type}");
    using var stream = new MemoryStream(System.Text.Encoding.UTF8.GetBytes(body.GetRawText()));
    var node = new JsonParseNodeFactory().GetRootParseNode("application/json", stream);
    var factory = type.GetMethod("CreateFromDiscriminatorValue", BindingFlags.Public | BindingFlags.Static)
        ?? throw new InvalidOperationException($"Missing Kiota factory on {type}");
    return node.GetObjectValue(parseNode => (IParsable)factory.Invoke(null, new object[] { parseNode })!);
}

static object? Serialize(object? value)
{
    if (value is null) return null;
    if (value is IParsable model)
    {
        using var writer = new JsonSerializationWriter();
        writer.WriteObjectValue(null, model);
        using var document = JsonDocument.Parse(writer.GetSerializedContent());
        return document.RootElement.Clone();
    }
    return value;
}

static string Key(string name) => new(name.Where(char.IsLetterOrDigit).Select(char.ToLowerInvariant).ToArray());

sealed class LoopbackHandler : HttpClientHandler
{
    private readonly int _port;
    public LoopbackHandler(int port) { _port = port; AllowAutoRedirect = false; }
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        if (request.RequestUri?.Host != "127.0.0.1" || request.RequestUri.Port != _port || request.RequestUri.Scheme != "https")
            throw new InvalidOperationException("Contract adapter refused a non-loopback request");
        request.RequestUri = new UriBuilder(request.RequestUri) { Scheme = "http", Port = _port }.Uri;
        return base.SendAsync(request, cancellationToken);
    }
}