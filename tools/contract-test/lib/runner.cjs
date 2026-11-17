const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const busboy = require('busboy');
const sampler = require('openapi-sampler');
const Ajv2020 = require('ajv/dist/2020').default;
const AjvDraft4 = require('ajv-draft-04');
const addFormats = require('ajv-formats');

const methods = new Set(['get', 'post', 'put', 'patch', 'delete']);

function resolve(spec, schema) {
  while (schema.$ref) {
    if (!schema.$ref.startsWith('#/')) throw new Error(`External reference not supported: ${schema.$ref}`);
    schema = schema.$ref.slice(2).split('/').reduce((value, segment) =>
      value[segment.replace(/~1/g, '/').replace(/~0/g, '~')], spec);
  }
  return schema;
}

function sample(spec, schema, kind = 'request') {
  const value = sampler.sample(schema, {
    skipNonRequired: true,
    skipReadOnly: kind === 'request',
    skipWriteOnly: kind === 'response',
    quiet: true,
  }, spec);
  checkSchema(spec, schema, value);
  return value;
}

function checkSchema(spec, schema, value) {
  const normalized = structuredClone(spec.components || {});
  function fixEnums(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'object' && Array.isArray(node.enum) && node.enum.every(item => typeof item === 'string')) {
      delete node.type;
    }
    for (const child of Object.values(node)) fixEnums(child);
  }
  const definition = structuredClone(schema);
  fixEnums(normalized);
  fixEnums(definition);
  const Validator = spec.openapi.startsWith('3.1') ? Ajv2020 : AjvDraft4;
  const validator = addFormats(new Validator({ strict: false, validateSchema: false, allowUnionTypes: true }))
    .compile({ ...definition, components: normalized });
  if (!validator(value)) throw new Error(`Generated sample does not match schema: ${JSON.stringify(validator.errors)}`);
}

function serverPath(spec) {
  if (!spec.servers?.length) return '';
  let url = spec.servers[0].url;
  for (const [name, variable] of Object.entries(spec.servers[0].variables || {})) {
    url = url.replaceAll(`{${name}}`, String(variable.default));
  }
  if (/[{}]/.test(url)) throw new Error(`Unresolved server URL: ${url}`);
  return new URL(url).pathname.replace(/\/$/, '');
}

function makeCases(specFile, includeErrors = false) {
  const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
  const base = serverPath(spec);
  const cases = [];
  for (const [route, pathItem] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!methods.has(method)) continue;
      const id = `${path.parse(specFile).name}:${method.toUpperCase()}:${route}`;
      const requestContent = resolve(spec, operation.requestBody || {}).content || {};
      const multipartSchema = requestContent['multipart/form-data']?.schema;
      const binaryPart = multipartSchema && Object.entries(resolve(spec, multipartSchema).properties || {})
        .find(([, property]) => resolve(spec, property).format === 'binary');
      const octetSchema = requestContent['application/octet-stream']?.schema;
      const binaryOctet = octetSchema && resolve(spec, octetSchema).format === 'binary';
      const parameters = [...(pathItem.parameters || []), ...(operation.parameters || [])]
        .map(parameter => resolve(spec, parameter))
        .filter(parameter => ['path', 'query', 'header'].includes(parameter.in))
        .map(parameter => ({
          name: parameter.name,
          in: parameter.in,
          value: parameter.name.toLowerCase() === 'content-type' && (binaryPart || binaryOctet)
            ? binaryPart ? 'multipart/form-data' : 'application/octet-stream'
            : parameter.name.toLowerCase() === 'content-length' && (binaryOctet ||
              (!operation.requestBody && ['post', 'put', 'patch'].includes(method)))
              ? binaryOctet ? String(Buffer.byteLength('contract-upload')) : '0'
              : ['content-type', 'accept'].includes(parameter.name.toLowerCase())
              ? 'application/json' : sample(spec, parameter.schema || { type: 'string' }),
        }));
      const bodySchema = requestContent['application/json']?.schema;
      const body = bodySchema ? sample(spec, bodySchema) : binaryPart
        ? { mediaType: 'multipart/form-data', part: binaryPart[0], dataBase64: Buffer.from('contract-upload').toString('base64') }
        : binaryOctet ? { mediaType: 'application/octet-stream', dataBase64: Buffer.from('contract-upload').toString('base64') }
        : null;
      const successes = Object.entries(operation.responses)
        .filter(([code]) => /^2\d\d$/.test(code))
        .sort(([left], [right]) => Number(left) - Number(right));
      if (!successes.length) throw new Error(`No success response: ${id}`);
      const [statusCode, success] = successes[0];
      const status = Number(statusCode);
      let responseSchema = status === 204 ? null : resolve(spec, success).content?.['application/json']?.schema;
      if (responseSchema) {
        const definition = resolve(spec, responseSchema);
        if (definition.type === 'object' && !['properties', 'required', 'allOf', 'oneOf', 'anyOf']
          .some(field => field in definition)) responseSchema = null;
      }
      const response = responseSchema ? sample(spec, responseSchema, 'response') : null;
      cases.push({ id, operationId: operation.operationId, method: method.toUpperCase(),
        path: base + route, parameters, body, hasRequestBody: operation.requestBody != null, status, response,
        responseUnspecified: status !== 204 && !responseSchema,
        responseHeaders: status === 201 ? { Location: '/contract123' } : {} });
      if (includeErrors) {
        const errors = Object.entries(operation.responses)
          .filter(([code]) => /^4\d\d$/.test(code))
          .sort(([left], [right]) => Number(left) - Number(right));
        if (errors.length) {
          const [errorCode, errorResponse] = errors[0];
          const errorSchema = resolve(spec, errorResponse).content?.['application/json']?.schema;
          cases.push({ id: `${id}:${errorCode}`, operationId: operation.operationId,
            method: method.toUpperCase(), path: base + route, parameters, body,
            hasRequestBody: operation.requestBody != null,
            status: Number(errorCode), response: errorSchema ? sample(spec, errorSchema, 'response') : null,
            responseUnspecified: false, responseHeaders: {} });
        }
      }
    }
  }
  return cases;
}

function assertSubset(expected, actual, label) {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || expected.length !== actual.length) {
      throw new Error(`${label}: array mismatch: ${JSON.stringify(actual)}`);
    }
    expected.forEach((value, index) => assertSubset(value, actual[index], `${label}[${index}]`));
  } else if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) {
      throw new Error(`${label}: expected object, got ${JSON.stringify(actual)}`);
    }
    for (const [key, value] of Object.entries(expected)) {
      if (!Object.hasOwn(actual, key)) throw new Error(`${label}: missing ${key}`);
      assertSubset(value, actual[key], `${label}.${key}`);
    }
  } else if (!isDeepStrictEqual(expected, actual)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function verifyRequest(testCase, request) {
  if (request.method !== testCase.method) throw new Error(`HTTP method: ${request.method} != ${testCase.method}`);
  let expectedPath = testCase.path;
  for (const parameter of testCase.parameters) {
    if (parameter.in === 'path') {
      expectedPath = expectedPath.replace(`{${parameter.name}}`, encodeURIComponent(String(parameter.value)));
    }
  }
  const parsed = new URL(request.path, 'http://127.0.0.1');
  if (parsed.pathname.replace(/\/$/, '') !== expectedPath.replace(/\/$/, '')) {
    throw new Error(`path: ${parsed.pathname} != ${expectedPath}`);
  }
  for (const parameter of testCase.parameters) {
    if (parameter.in === 'query' && parameter.value !== null) {
      const expected = (Array.isArray(parameter.value) ? parameter.value : [parameter.value]).map(String);
      const actual = parsed.searchParams.getAll(parameter.name);
      if (!isDeepStrictEqual(actual, expected)) {
        throw new Error(`query ${parameter.name}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
      }
    }
    if (parameter.in === 'header' && !['content-type', 'accept'].includes(parameter.name.toLowerCase())) {
      if (request.headers[parameter.name.toLowerCase()] !== String(parameter.value)) {
        throw new Error(`header ${parameter.name} mismatch`);
      }
    }
  }
  if (request.headers.authorization !== 'Bearer contract-token') throw new Error('Bearer authorization missing');
  if (testCase.body?.mediaType && !request.headers['content-type']?.startsWith(testCase.body.mediaType)) {
    throw new Error(`content-type: expected ${testCase.body.mediaType}, got ${request.headers['content-type']}`);
  }
  if (testCase.body !== null) assertSubset(testCase.body, request.body, 'request body');
}

function caseLog(testCase, request, result, errorMessage, detailed = false) {
  const allowed = new Set(['content-type', 'accept', 'x-contract-case-id']);
  for (const parameter of testCase.parameters) {
    if (parameter.in === 'header' && !['authorization', 'cookie', 'proxy-authorization', 'x-api-key']
      .includes(parameter.name.toLowerCase())) allowed.add(parameter.name.toLowerCase());
  }
  const actual = request ? { method: request.method, path: request.path,
    headers: Object.fromEntries(Object.entries(request.headers).filter(([name]) => allowed.has(name))),
    body: request.body } : null;
  const fixture = { method: testCase.method, path: testCase.path,
    parameters: testCase.parameters, body: testCase.body };
  const mock = { status: testCase.status, body: testCase.response };
  const label = `${errorMessage ? 'FAIL' : 'PASS'} ${testCase.id} (${testCase.operationId})`;
  const entries = [['fixture', fixture], ['actual', actual], ['mock', mock], ['sdk', result]];
  if (detailed) return [label, `  Reason: ${errorMessage}`,
    ...entries.map(([name, value]) => `  ${name}: ${JSON.stringify(value, null, 2)}`)].join('\n');
  return [label, ...entries.map(([name, value]) => `${name}=${JSON.stringify(value)}`),
    ...(errorMessage ? [`reason=${JSON.stringify(errorMessage)}`] : [])].join(' | ');
}

function invokeAdapter(command, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command[0], command.slice(1), { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stdout.resume();
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-3000); });
    child.on('error', reject);
    child.on('close', code => resolvePromise({ code, stderr }));
  });
}

function parseMultipart(bytes, headers, part) {
  return new Promise((resolvePromise, reject) => {
    const parser = busboy({ headers, defCharset: 'latin1' });
    let fileBytes = null;
    const names = [];
    parser.on('file', (name, stream) => {
      names.push(name);
      const chunks = [];
      stream.on('data', chunk => chunks.push(chunk));
      stream.on('end', () => { if (name === part) fileBytes = Buffer.concat(chunks); });
    });
    parser.on('field', (name, value) => {
      names.push(name);
      if (name === part) fileBytes = Buffer.from(value, 'latin1');
    });
    parser.on('error', reject);
    parser.on('close', () => resolvePromise(fileBytes === null
      ? { error: `Multipart part ${part} missing; received ${names.join(', ')}`, byteLength: bytes.length }
      : { mediaType: 'multipart/form-data', part, dataBase64: fileBytes.toString('base64') }));
    parser.end(bytes);
  });
}

async function run(specs, adapter, includeErrors = false) {
  const cases = specs.flatMap(spec => makeCases(spec, includeErrors));
  if (!cases.length) throw new Error('No OpenAPI operations found');
  const byId = new Map(cases.map(testCase => [testCase.id, testCase]));
  const received = new Map();
  const unexpected = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', async () => {
      const bytes = Buffer.concat(chunks);
      const raw = bytes.toString('utf8');
      let body = null;
      if (request.headers['content-type']?.startsWith('multipart/form-data')) {
        try {
          const part = byId.get(request.headers['x-contract-case-id'])?.body?.part;
          body = await parseMultipart(bytes, request.headers, part);
        } catch (error) { body = { error: error.message, byteLength: bytes.length }; }
      } else if (request.headers['content-type']?.startsWith('application/octet-stream')) {
        body = { mediaType: 'application/octet-stream', dataBase64: bytes.toString('base64') };
      } else if (raw) {
        try { body = JSON.parse(raw); } catch { body = raw; }
      }
      const id = request.headers['x-contract-case-id'];
      const testCase = byId.get(id);
      if (!testCase || received.has(id)) {
        unexpected.push(`${request.method} ${request.url} (${id})`);
        response.writeHead(500).end('Unknown or duplicate contract case');
        return;
      }
      received.set(id, { method: request.method, path: request.url, headers: request.headers, body });
      const data = testCase.response === null ? '' : JSON.stringify(testCase.response);
      response.writeHead(testCase.status, {
        ...(data ? { 'Content-Type': 'application/json' } : {}),
        ...testCase.responseHeaders, 'Content-Length': Buffer.byteLength(data),
      }).end(data);
    });
  });
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-contract-'));
  const manifest = path.join(temp, 'cases.json');
  const results = path.join(temp, 'results.json');
  try {
    fs.writeFileSync(manifest, JSON.stringify({ port: server.address().port, cases }));
    const completed = await invokeAdapter(adapter, {
      ...process.env, CONTRACT_CASES: manifest, CONTRACT_RESULTS: results,
    });
    const decoded = fs.existsSync(results) ? JSON.parse(fs.readFileSync(results, 'utf8')) : [];
    const failures = [];
    const failedCases = [];
    if (completed.code !== 0) failures.push(`Adapter exit ${completed.code}: ${completed.stderr}`);
    for (const [index, testCase] of cases.entries()) {
      const request = received.get(testCase.id) || null;
      const result = decoded[index] ?? null;
      let reason = null;
      try {
        if (result === null) throw new Error('Adapter produced no result');
        if (Object.hasOwn(result, 'error')) throw new Error(result.error);
        if (request === null) throw new Error('SDK sent no request');
        verifyRequest(testCase, request);
        if (testCase.status >= 400 && result.status !== testCase.status) {
          throw new Error(`SDK error status: ${result.status} != ${testCase.status}`);
        }
        if (testCase.response !== null) assertSubset(testCase.response, result.response, 'decoded response');
      } catch (error) {
        reason = error.message;
        failedCases.push(caseLog(testCase, request, result, reason, true));
      }
      console.log(caseLog(testCase, request, result, reason));
    }
    if (received.size !== cases.length || decoded.length !== cases.length) {
      failures.push(`Coverage: ${received.size} requests, ${decoded.length} results / ${cases.length} operations`);
    }
    failures.push(...unexpected.map(value => `Unexpected request: ${value}`));
    const errorCount = cases.filter(testCase => testCase.status >= 400).length;
    const unspecified = cases.filter(testCase => testCase.responseUnspecified).length;
    console.log('='.repeat(72));
    console.log(`Contract: ${cases.length} cases (${cases.length - failedCases.length} passed, `
      + `${failedCases.length} failed); ${cases.length - errorCount} success fixtures, `
      + `${errorCount} error fixtures; ${unspecified} unspecified response bodies; other issues: ${failures.length}`);
    console.log('='.repeat(72));
    if (failedCases.length) console.log(`Failed cases (${failedCases.length}):\n${failedCases.join('\n\n')}`);
    if (failures.length) console.log(`Other failures:\n${failures.map(value => `FAIL ${value}`).join('\n')}`);
    return failures.length || failedCases.length ? 1 : 0;
  } finally {
    await new Promise(resolvePromise => server.close(resolvePromise));
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function specsInDirectory(directory) {
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    throw new Error(`Spec directory not found: ${directory}`);
  }
  const files = [];
  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && entry.name.endsWith('.json')) files.push(file);
    }
  }
  visit(directory);
  if (!files.length) throw new Error(`No OpenAPI JSON specs found in: ${directory}`);
  return files.sort();
}

function parseArgs(args) {
  const specs = [];
  let specDirectory = null;
  let includeErrors = false;
  let index = 0;
  while (index < args.length && args[index] !== '--') {
    if (args[index] === '--errors') { includeErrors = true; index += 1; }
    else if (args[index] === '--spec' && args[index + 1]) { specs.push(args[index + 1]); index += 2; }
    else if (args[index] === '--spec-directory' && args[index + 1]) {
      if (specDirectory !== null) throw new Error('Provide --spec-directory only once');
      specDirectory = args[index + 1];
      index += 2;
    }
    else throw new Error(`Unknown runner argument: ${args[index]}`);
  }
  if (args[index] !== '--' || index === args.length - 1 || (!specs.length && specDirectory === null)) {
    throw new Error('Usage: node runner.cjs [--errors] (--spec-directory <dir> | --spec <file> [--spec <file> ...]) -- <adapter command>');
  }
  if (specDirectory !== null && specs.length) throw new Error('Provide either --spec-directory or --spec, not both');
  return { specs: specDirectory === null ? specs : specsInDirectory(specDirectory),
    includeErrors, adapter: args.slice(index + 1) };
}

if (require.main === module) {
  try {
    const { specs, adapter, includeErrors } = parseArgs(process.argv.slice(2));
    run(specs, adapter, includeErrors).then(code => { process.exitCode = code; })
      .catch(error => { console.error(error); process.exitCode = 1; });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { assertSubset, checkSchema, makeCases, parseArgs, parseMultipart, resolve, run, sample, serverPath, verifyRequest };