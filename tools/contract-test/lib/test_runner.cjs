const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { assertSubset, makeCases, parseArgs, parseMultipart, sample, verifyRequest } = require('./runner.cjs');

test('locked dependencies use the public npm registry', () => {
  const lock = JSON.parse(fs.readFileSync(path.join(__dirname, '../package-lock.json'), 'utf8'));
  for (const [name, dependency] of Object.entries(lock.packages)) {
    if (dependency.resolved) {
      assert.equal(new URL(dependency.resolved).origin, 'https://registry.npmjs.org', name);
    }
  }
});

test('sampler includes only required schema fields', () => {
  const schema = { type: 'object', required: ['requiredField'], properties: {
    optionalField: { type: 'string' }, requiredField: { type: 'integer' },
    serverField: { type: 'string', readOnly: true },
  } };
  assert.deepEqual(sample({ openapi: '3.1.0' }, schema), { requiredField: 0 });
  assert.deepEqual(sample({ openapi: '3.1.0' }, schema, 'response'), { requiredField: 0 });
});

test('case generation samples OpenAPI references for request and response', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-spec-'));
  try {
    const specFile = path.join(folder, 'example.json');
    fs.writeFileSync(specFile, JSON.stringify({ openapi: '3.1.0', servers: [{ url: 'https://api.example.com/v1' }],
      paths: { '/items': { post: { operationId: 'createItem', requestBody: { content: {
        'application/json': { schema: { $ref: '#/components/schemas/Item' } },
      } }, responses: { '201': { content: { 'application/json': {
        schema: { $ref: '#/components/schemas/Item' },
      } } }, '400': { description: 'Bad request' } } } } },
      components: { schemas: { Item: { type: 'object', required: ['name'], properties: {
        name: { type: 'string', example: 'sample' }, extra: { type: 'boolean' },
      } } } },
    }));
    const cases = makeCases(specFile, true);
    assert.equal(cases.length, 2);
    assert.equal(cases[0].path, '/v1/items');
    assert.deepEqual(cases[0].body, { name: 'sample' });
    assert.deepEqual(cases[0].response, { name: 'sample' });
    assert.equal(cases[1].status, 400);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('case generation creates a binary multipart fixture from the upload schema', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-spec-'));
  try {
    const specFile = path.join(folder, 'upload.json');
    fs.writeFileSync(specFile, JSON.stringify({ openapi: '3.0.0', paths: {
      '/files': { post: { operationId: 'uploadFile', requestBody: { content: {
        'multipart/form-data': { schema: { type: 'object', properties: {
          file: { type: 'string', format: 'binary' },
        } } },
      } }, responses: { '204': { description: 'Uploaded' } } } },
    } }));
    assert.deepEqual(makeCases(specFile)[0].body, {
      mediaType: 'multipart/form-data', part: 'file',
      dataBase64: Buffer.from('contract-upload').toString('base64'),
    });
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('case generation makes octet-stream bytes match Content-Length', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-spec-'));
  try {
    const specFile = path.join(folder, 'upload.json');
    fs.writeFileSync(specFile, JSON.stringify({ openapi: '3.0.0', paths: {
      '/video': { post: { operationId: 'uploadVideo', parameters: [
        { name: 'Content-Length', in: 'header', schema: { type: 'string' } },
        { name: 'Content-Type', in: 'header', schema: { type: 'string' } },
      ], requestBody: { content: { 'application/octet-stream': {
        schema: { type: 'string', format: 'binary' },
      } } }, responses: { '200': { description: 'OK' } } } },
    } }));
    const fixture = makeCases(specFile)[0];
    assert.equal(fixture.parameters[0].value, String(Buffer.byteLength('contract-upload')));
    assert.equal(fixture.parameters[1].value, 'application/octet-stream');
    assert.deepEqual(fixture.body, { mediaType: 'application/octet-stream',
      dataBase64: Buffer.from('contract-upload').toString('base64') });
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('case generation expects an empty POST body to have Content-Length zero', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-spec-'));
  try {
    const specFile = path.join(folder, 'upload.json');
    fs.writeFileSync(specFile, JSON.stringify({ openapi: '3.0.0', paths: {
      '/video/{video_id}/upload': { post: { operationId: 'uploadVideo', parameters: [
        { name: 'video_id', in: 'path', schema: { type: 'string' } },
        { name: 'Content-Length', in: 'header', schema: { type: 'string' } },
      ], responses: { '200': { description: 'OK' } } }, get: { operationId: 'getVideo', parameters: [
        { name: 'Content-Length', in: 'header', schema: { type: 'string' } },
      ], responses: { '200': { description: 'OK' } } } },
    } }));
    const [fixture, getFixture] = makeCases(specFile);
    assert.equal(fixture.body, null);
    assert.equal(fixture.parameters[1].value, '0');
    assert.equal(getFixture.parameters[0].value, 'string');
    verifyRequest(fixture, { method: 'POST', path: '/video/string/upload',
      headers: { authorization: 'Bearer contract-token', 'content-length': '0' }, body: null });
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('request verification checks path, query, header, token and body', () => {
  const testCase = { method: 'POST', path: '/items/{item_id}', parameters: [
    { name: 'item_id', in: 'path', value: 'a/b' },
    { name: 'filter', in: 'query', value: 'active' },
    { name: 'X-Region', in: 'header', value: 'US' },
  ], body: { name: 'example' } };
  const request = { method: 'POST', path: '/items/a%2Fb?filter=active',
    headers: { authorization: 'Bearer contract-token', 'x-region': 'US' }, body: { name: 'example' } };
  verifyRequest(testCase, request);
  assert.throws(() => verifyRequest(testCase, { ...request, body: { name: 'wrong' } }), /request body.name/);
  assert.throws(() => assertSubset({ limit: 1 }, {}, 'decoded response'), /decoded response: missing limit/);
});

test('request verification checks multipart content type and file bytes', () => {
  const body = { mediaType: 'multipart/form-data', part: 'file',
    dataBase64: Buffer.from('contract-upload').toString('base64') };
  const testCase = { method: 'POST', path: '/files', parameters: [], body };
  const request = { method: 'POST', path: '/files',
    headers: { authorization: 'Bearer contract-token', 'content-type': 'multipart/form-data; boundary=test' }, body };
  verifyRequest(testCase, request);
  assert.throws(() => verifyRequest(testCase, { ...request, body: { ...body, dataBase64: 'd3Jvbmc=' } }), /dataBase64/);
  assert.throws(() => verifyRequest(testCase, { ...request,
    headers: { ...request.headers, 'content-type': 'application/json' } }), /content-type/);
});

test('multipart parser preserves non-UTF-8 file bytes without a filename', async () => {
  const content = Buffer.from([0, 255, 65]);
  const bytes = Buffer.concat([
    Buffer.from('--test\r\nContent-Disposition: form-data; name="file"\r\n\r\n'),
    content,
    Buffer.from('\r\n--test--\r\n'),
  ]);
  assert.deepEqual(await parseMultipart(bytes, { 'content-type': 'multipart/form-data; boundary=test' }, 'file'), {
    mediaType: 'multipart/form-data', part: 'file', dataBase64: content.toString('base64'),
  });
});

test('runner serves by case ID but fails a mismatched request', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-run-'));
  try {
    const specFile = path.join(folder, 'example.json');
    fs.writeFileSync(specFile, JSON.stringify({ openapi: '3.1.0', paths: {
      '/items': { get: { operationId: 'listItems', responses: {
        '200': { content: { 'application/json': { schema: { type: 'object',
          required: ['total'], properties: { total: { type: 'integer' } } } } } },
      } } },
    } }));
    const adapter = `const fs=require('node:fs'),http=require('node:http');` +
      `const manifest=JSON.parse(fs.readFileSync(process.env.CONTRACT_CASES));` +
      `const request=http.get({hostname:'127.0.0.1',port:manifest.port,path:'/wrong',` +
      `headers:{'X-Contract-Case-Id':manifest.cases[0].id}},response=>{let body='';` +
      `response.on('data',chunk=>body+=chunk);response.on('end',()=>{` +
      `fs.writeFileSync(process.env.CONTRACT_RESULTS,JSON.stringify([{response:JSON.parse(body)}]));});});` +
      `request.on('error',error=>{console.error(error);process.exitCode=1;});`;
    const result = spawnSync(process.execPath, [path.join(__dirname, 'runner.cjs'),
      '--spec', specFile, '--', process.execPath, '-e', adapter], { encoding: 'utf8' });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /path: \/wrong != \/items/);
    assert.match(result.stdout, /mock=\{"status":200,"body":\{"total":0\}\}/);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('runner CLI requires specs and an adapter command', () => {
  assert.deepEqual(parseArgs(['--errors', '--spec', 'a.json', '--', 'java']), {
    specs: ['a.json'], includeErrors: true, adapter: ['java'],
  });
  assert.throws(() => parseArgs(['--spec', 'a.json']), /Usage:/);
});