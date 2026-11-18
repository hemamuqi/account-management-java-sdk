# OpenAPI SDK contract regression

The runner in `lib/runner.cjs` is language-neutral. It reads OpenAPI JSON specs,
generates one deterministic positive fixture per HTTP operation, serves those
fixtures from a loopback mock server, and checks the actual SDK request and the
decoded SDK response. Missing operations, unexpected requests, wrong paths,
query parameters, headers, request bodies, or response fields fail the run.
No eBay credentials or network API calls are needed.

## Java SDK

Requires Java 17+, Node.js 22+ and Gradle. From the repository root:

```bash
npm ci --prefix tools/contract-test
node --test tools/contract-test/lib/test_runner.cjs
node tools/contract-test/lib/runner.cjs \
  --spec specs/openapi/account-v1.json \
  --spec specs/openapi/account-v2.json \
  --spec specs/openapi/finances.json \
  -- ./gradlew -p tools/contract-test contractTestAdapter --no-daemon --quiet
```

The contract adapter has its own Gradle settings and build under
`tools/contract-test`. Running Gradle with `-p tools/contract-test` configures
the adapter project and includes the SDK project using its normal build file.
Ordinary SDK builds do not configure the adapter, and the adapter is not part
of the published SDK.

`.github/workflows/contract.yml` runs the same check on relevant pull requests
and pushes to `main`, and supports manual runs. Pass `--errors` before the
`--spec` arguments to also
exercise one declared 4xx response per operation; manual workflow runs expose
the same option. The Java-only adapter lives under `adapters/java` and
is compiled by Gradle but is not part of the published SDK. The SDK's
`forLocalTesting(port)` configuration explicitly opts into `127.0.0.1`; normal
custom URLs remain limited to the eBay hosts.
The workflow passes `spec-directory: specs/openapi` to the action, which scans
that directory recursively for every `.json` file in a stable order. An empty
or missing directory fails the run. Callers may instead pass a space-separated
`specs` list, but must not set both inputs.

After the adapter finishes, the runner prints one labeled `PASS` or `FAIL` line
per case with the case ID, operation, spec fixture (`fixture`), actual request
(`actual`, or `null` if none was sent), mock response (`mock`), and decoded SDK
result (`sdk`). Failed lines include a reason. Request headers in the log are
limited to the test case ID, content negotiation, and non-sensitive spec headers.
The `Contract:` summary is framed by separator lines. Below it, failed cases
are repeated with indented request/response details; adapter and coverage
errors are listed separately.

## Reuse with another Java SDK

Each Java SDK compiles the same shared adapter source; no per-repository JSON
mapping is required. At runtime the adapter scans only that SDK's compiled
class directories for a unique configuration/facade pair. The configuration
must have `public static forLocalTesting(int)` and `setAccessToken(String)`;
the `AutoCloseable` facade must have a public constructor accepting the
configuration. The facade must expose REST clients as public fields or `get...`
methods. A REST method is selected by the spec's `operationId + "Async"`;
when multiple clients have that method, the client name must match the spec
filename (for example `listing-v1.json` and `listingV1`). SDK parameter names
must match spec parameters after punctuation/case normalization. Missing or
ambiguous matches fail the test, not silently skip it.

Methods must return `CompletableFuture`, accept Kiota `Parsable` request and
response models, and have a `requestOptions` parameter whose type supports
`addHeader(String, String)`. The SDK must explicitly allow loopback in its
**test-only** configuration and authentication host policy. SDKs with other
naming or API patterns can still use the language-neutral runner with a custom
adapter. No Java source is generated at runtime; the compiled SDK is inspected.

In the listing SDK's Gradle build, compile the shared adapter from the path
provided by the action:

```kotlin
val compileContractAdapter by tasks.registering(JavaCompile::class) {
  val sourcePath = System.getenv("CONTRACT_JAVA_ADAPTER_SOURCE")
    ?: "tools/contract-test/adapters/java/src"
  source = fileTree(sourcePath) { include("**/*.java") }
  classpath = sourceSets.main.get().runtimeClasspath
  destinationDirectory.set(layout.buildDirectory.dir("classes/java/contractAdapter"))
  options.release.set(17)
  dependsOn(tasks.named("classes"))
}

tasks.register<JavaExec>("contractTestAdapter") {
  dependsOn(compileContractAdapter)
  classpath = files(compileContractAdapter.map { it.destinationDirectory }) + sourceSets.main.get().runtimeClasspath
  mainClass.set("sdk.contract.ContractAdapter")
  environment("CONTRACT_SDK_CLASSES", sourceSets.main.get().output.classesDirs.asPath)
}
```

Enable Java method parameter names (`tasks.withType<JavaCompile>().configureEach
{ options.compilerArgs.add("-parameters") }`). In CI, use
`adapter-command: ./gradlew contractTestAdapter --no-daemon --quiet`. Locally,
point `CONTRACT_JAVA_ADAPTER_SOURCE` to this repository's adapter source and
run this repository's Node runner against the listing spec. No JSON mapping
file is needed in either repository.

## Other languages

The composite action at `.github/actions/contract-test` can be called from a
PHP or other SDK repository. Set up that repository's runtime and dependencies
before calling it. Reference a pinned commit SHA after publishing this action:

```yaml
- uses: actions/checkout@<pinned-checkout-sha>
- name: Install SDK dependencies
  run: composer install --no-interaction --prefer-dist
- uses: eBay/account-management-java-sdk/.github/actions/contract-test@<pinned-commit-sha>
  with:
    spec-directory: specs/openapi
    adapter-command: php tools/contract-test/adapter.php
    include-errors: 'false' # set to 'true' to validate 4xx SDK exceptions
```

The action installs Node.js and the runner's locked npm dependencies;
the caller provides only the SDK adapter. The runner invokes the adapter once,
with these environment variables:

- `CONTRACT_CASES`: path to JSON `{ "port": 12345, "cases": [...] }`.
- `CONTRACT_RESULTS`: path where the adapter writes a JSON array, one result per
  input case, in the same order. Each result is `{ "response": <decoded JSON> }`
  for a successful response, `{ "status": <HTTP status>, "response": <decoded
  error JSON> }` for a 4xx exception, or `{ "error": "reason" }` for an adapter
  failure. An error result may omit `response` when the spec declares no JSON
  schema. Record failures and continue with later cases.

Each case has `id`, `operationId`, `method`, `path`, `parameters` (each with
`name`, `in`, `value`), `body`, `status`, `response`, and `responseHeaders`.
`id` is unique even when an OpenAPI document reuses an `operationId`. For each
case, invoke the **public SDK** against `http://127.0.0.1:<port>` using its own
local-test configuration, set the bearer token to `contract-token`, and add
`X-Contract-Case-Id: <id>` to that call. The mock selects the correct fixture
using this ID; without it the request is reported as unexpected. Write the
SDK-decoded result, not the mock response copied from the manifest. Do not send
requests directly with an HTTP library in place of the SDK.

The same runner CLI can also be used locally in other language repositories:
run `npm ci` in this repository's `tools/contract-test` directory and pass their
adapter command after `--`.

## Limits

Samples are generated by `openapi-sampler` from required schema properties,
with request `readOnly` and response `writeOnly` fields omitted. Ajv validates
each generated sample before the SDK is invoked. This is a deterministic smoke
contract, not exhaustive API validation. The
default exercises one generated success case per REST operation; `--errors`
adds one declared 4xx case per operation where available. It does not cover
other error statuses, optional-field combinations, pagination variants or
GraphQL. Three declared 4xx responses have no JSON schema, so only their
exception status can be checked. Schema fields
which are enums of strings but incorrectly declare `type: object` are validated
as enums. A `204` response has no body even when the spec erroneously assigns
one; successful schemas that only say `type: object` with no fields are treated
as unspecified response bodies and counted in the output. Add explicit schema
properties to the spec to check those responses. The runner fails closed when
an operation cannot be generated or the adapter does not cover it.

For request bodies, the Java adapter also rejects fields that Kiota parses as
unknown additional data, including fields in nested models. Echoing those
fields into the HTTP request does not mean the SDK exposes typed properties.

At present, `--errors` reports two known mismatches: the lowercase-path
Finances payout and transfer operations declare a 401 error model in the spec,
but their generated Kiota request builders do not register an error mapping.
Their HTTP status is preserved while the response body is not decoded. Keep
the error suite opt-in until those generated mappings are fixed at the source.