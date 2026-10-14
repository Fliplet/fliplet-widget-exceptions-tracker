// DEV-1231 regression harness for the build.html Sentry transport.
//
// The widget has no browser test rig, so this evaluates the build.html
// <script> in a vm with Fliplet, Raven, document and XMLHttpRequest stubbed,
// then drives Raven's transport callback directly. Run with: node test/build-transport.js
//
// What it pins down: the credential leaves the URL and travels as a header; a
// blocked preflight (status 0) falls back to Raven's query sender exactly once
// and stays fallen back; a real HTTP error does NOT fall back, so a rate-limit
// response can never push the token back into a URL.

const fs = require('fs');
const vm = require('vm');
const path = require('path').join(__dirname, '..', 'build.html');
const html = fs.readFileSync(path, 'utf8');
const script = html.match(/<script type="text\/javascript">([\s\S]*)<\/script>/)[1];

let xhrs = [];
let ravenConfig = null;

function makeSandbox() {
  xhrs = [];
  const env = {
    environment: 'production', region: 'eu', appName: 'A', appId: 1,
    masterAppId: 1, pageId: 2, apiUrl: 'https://api.fliplet.com/',
    user: { auth_token: 'eu--session--SECRET' }, mode: 'interact'
  };
  const sandbox = {
    console,
    JSON,
    Object,
    Error,
    encodeURIComponent,
    XMLHttpRequest: function() {
      const self = this;
      this.headers = {};
      this.readyState = 0;
      this.status = 0;
      this.open = (m, u) => { self.method = m; self.url = u; };
      this.setRequestHeader = (k, v) => { self.headers[k] = v; };
      this.send = (b) => { self.body = b; };
      xhrs.push(this);
    },
    document: { querySelectorAll: () => [{ dataset: { exceptionsTrackerId: '77' } }] },
    window: { __widgetData: { 77: { data: {} } } },
    Fliplet: Object.assign(
      function() { return { then: (fn) => fn() }; },
      {
        Env: { get: (k) => env[k], is: () => false },
        User: { getAuthToken: () => env.user.auth_token }
      }
    ),
    Raven: {
      ea(options) { this.legacyCalls = (this.legacyCalls || 0) + 1; this.lastLegacy = options; },
      config(dsn, options) { ravenConfig = options; return this; },
      install() { return this; },
      setUserContext() {}, setExtraContext() {}, setTagsContext() {}
    }
  };
  sandbox.window.__widgetData = { 77: { data: {} } };
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);
  return sandbox;
}

function transportOptions() {
  return { url: 'store/1', auth: { sentry_version: '7', sentry_key: 'k' }, data: { msg: 'boom' } };
}

let failures = 0;
function check(label, cond, detail) {
  if (cond) { console.log('  PASS  ' + label); }
  else { failures++; console.log('  FAIL  ' + label + (detail ? '  -> ' + detail : '')); }
}

// --- Case 1: header transport
let sb = makeSandbox();
let opts = transportOptions();
ravenConfig.transport.call(sb.Raven, opts);
let xhr = xhrs[0];
console.log('Case 1: first report uses the header transport');
check('one XHR issued', xhrs.length === 1);
check('POST', xhr.method === 'POST');
check('URL has no auth_token', xhr.url.indexOf('auth_token') === -1, xhr.url);
check('URL has no session token', xhr.url.indexOf('SECRET') === -1, xhr.url);
check('URL keeps the sentry auth params', xhr.url.indexOf('sentry_key=k') !== -1, xhr.url);
check('URL points at the raven proxy', xhr.url.indexOf('https://api.fliplet.com/v1/raven/') === 0, xhr.url);
check('Auth-token header set', xhr.headers['Auth-token'] === 'eu--session--SECRET', JSON.stringify(xhr.headers));
check('body is the serialised payload', xhr.body === JSON.stringify({ msg: 'boom' }), xhr.body);
check('legacy sender not used', !sb.Raven.legacyCalls);

// --- Case 2: blocked preflight -> fallback, and it sticks
console.log('Case 2: status 0 falls back and remembers');
xhr.readyState = 4; xhr.status = 0; xhr.onreadystatechange();
check('legacy sender used once', sb.Raven.legacyCalls === 1, String(sb.Raven.legacyCalls));
check('fallback re-added auth_token', sb.Raven.lastLegacy.auth.auth_token === 'eu--session--SECRET');
const before = xhrs.length;
ravenConfig.transport.call(sb.Raven, transportOptions());
check('no further XHR preflight attempted', xhrs.length === before, String(xhrs.length));
check('legacy sender used again', sb.Raven.legacyCalls === 2, String(sb.Raven.legacyCalls));

// --- Case 3: a real HTTP error does NOT fall back
console.log('Case 3: a 4xx does not fall back to the query transport');
sb = makeSandbox();
let onErrorCalled = false;
opts = transportOptions();
opts.onError = () => { onErrorCalled = true; };
ravenConfig.transport.call(sb.Raven, opts);
xhr = xhrs[0];
xhr.readyState = 4; xhr.status = 429; xhr.onreadystatechange();
check('legacy sender NOT used', !sb.Raven.legacyCalls, String(sb.Raven.legacyCalls));
check('onError reported', onErrorCalled);

// --- Case 4: success path
console.log('Case 4: 200 calls onSuccess');
sb = makeSandbox();
let okCalled = false;
opts = transportOptions();
opts.onSuccess = () => { okCalled = true; };
ravenConfig.transport.call(sb.Raven, opts);
xhr = xhrs[0];
xhr.readyState = 4; xhr.status = 200; xhr.onreadystatechange();
check('onSuccess called', okCalled);
check('legacy sender NOT used', !sb.Raven.legacyCalls);

console.log(failures ? '\n' + failures + ' FAILING' : '\nALL PASSING');
process.exit(failures ? 1 : 0);
