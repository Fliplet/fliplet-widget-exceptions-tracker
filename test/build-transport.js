// DEV-1231 regression harness for the build.html Sentry transport.
//
// The widget has no browser test rig, so this evaluates the build.html
// <script> in a vm with Fliplet, Raven, document and XMLHttpRequest stubbed,
// then drives Raven's transport callback directly. Run with: node test/build-transport.js
//
// What it pins down: the credential leaves the URL and travels as a header; a
// blocked preflight (status 0) falls back to Raven's query sender but only for
// a bounded window, so a transient fault cannot keep the token in the URL for
// the rest of the page session; an offline device does not downgrade at all; a
// real HTTP error does NOT fall back, so a rate-limit response can never push
// the token back into a URL; a circular payload still sends; and a failure
// carries the XHR that Raven's backoff requires.

const fs = require('fs');
const vm = require('vm');
const path = require('path').join(__dirname, '..', 'build.html');
const html = fs.readFileSync(path, 'utf8');
const script = html.match(/<script type="text\/javascript">([\s\S]*)<\/script>/)[1];

let xhrs = [];
let ravenConfig = null;
let clock = 1000000;

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
    Infinity,
    encodeURIComponent,
    // Controllable clock and connectivity: the transport's recovery window is
    // time-based, and status 0 is interpreted differently when the device
    // reports itself offline. Both have to be driveable to be testable.
    Date: { now: () => clock },
    navigator: { onLine: true },
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

// --- Case 2: blocked preflight -> bounded fallback
console.log('Case 2: status 0 falls back, but only for a bounded window');
xhr.readyState = 4; xhr.status = 0; xhr.onreadystatechange();
check('legacy sender used once', sb.Raven.legacyCalls === 1, String(sb.Raven.legacyCalls));
check('fallback re-added auth_token', sb.Raven.lastLegacy.auth.auth_token === 'eu--session--SECRET');
let before = xhrs.length;
ravenConfig.transport.call(sb.Raven, transportOptions());
check('no preflight retried inside the window', xhrs.length === before, String(xhrs.length));
check('legacy sender used again inside the window', sb.Raven.legacyCalls === 2, String(sb.Raven.legacyCalls));

// THE REGRESSION THIS CASE EXISTS FOR. The fallback used to be latched for the
// page session, so a few seconds offline put the live token in the URL of every
// later report for as long as the page stayed open.
console.log('Case 2b: the header transport is retried once the window elapses');
clock += 60001;
before = xhrs.length;
const legacyBefore = sb.Raven.legacyCalls;
ravenConfig.transport.call(sb.Raven, transportOptions());
check('a new header attempt is made', xhrs.length === before + 1, String(xhrs.length));
check('legacy sender NOT used again', sb.Raven.legacyCalls === legacyBefore, String(sb.Raven.legacyCalls));
const retried = xhrs[xhrs.length - 1];
check('retry carries the header', retried.headers['Auth-token'] === 'eu--session--SECRET');
check('retry URL has no credential', retried.url.indexOf('SECRET') === -1, retried.url);

console.log('Case 2c: a success clears the block immediately');
sb = makeSandbox();
ravenConfig.transport.call(sb.Raven, transportOptions());
xhrs[0].readyState = 4; xhrs[0].status = 0; xhrs[0].onreadystatechange();
check('fell back after status 0', sb.Raven.legacyCalls === 1);
clock += 60001;
ravenConfig.transport.call(sb.Raven, transportOptions());
const recovered = xhrs[xhrs.length - 1];
recovered.readyState = 4; recovered.status = 200; recovered.onreadystatechange();
// Block cleared by the success, so the very next report must not wait out
// another window.
before = xhrs.length;
ravenConfig.transport.call(sb.Raven, transportOptions());
check('next report uses the header transport straight away', xhrs.length === before + 1, String(xhrs.length));
check('legacy sender still used only once in total', sb.Raven.legacyCalls === 1, String(sb.Raven.legacyCalls));

// --- Case 2d: offline must not downgrade at all
console.log('Case 2d: an offline device does not put the token back in a URL');
sb = makeSandbox();
sb.navigator.onLine = false;
let offlineErr = null;
let offlineOpts = transportOptions();
offlineOpts.onError = (err) => { offlineErr = err; };
ravenConfig.transport.call(sb.Raven, offlineOpts);
const offlineXhr = xhrs[xhrs.length - 1];
offlineXhr.readyState = 4; offlineXhr.status = 0; offlineXhr.onreadystatechange();
// The query transport would have failed in exactly the same way, so there is
// nothing to gain by downgrading and a credential to lose.
check('legacy sender NOT used', !sb.Raven.legacyCalls, String(sb.Raven.legacyCalls));
check('onError reported', !!offlineErr);
before = xhrs.length;
sb.navigator.onLine = true;
ravenConfig.transport.call(sb.Raven, transportOptions());
check('transport not downgraded for later reports', xhrs.length === before + 1, String(xhrs.length));
check('still no legacy sender', !sb.Raven.legacyCalls, String(sb.Raven.legacyCalls));

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

// --- Case 5: a failure must carry the XHR, or Raven never backs off
// Raven 3.11.0's failure handler is `d.request && c.ba(d.request)` — it only
// engages its rate-limit backoff when the error object carries the request.
// Its own sender sets `b.request = c` for exactly that reason. Without it a
// 429, or a 401 from a misconfigured DSN, leaves backoff disabled and the
// client keeps hammering the proxy.
console.log('Case 5: an HTTP failure carries error.request for Raven backoff');
sb = makeSandbox();
let backoffErr = null;
opts = transportOptions();
opts.onError = (err) => { backoffErr = err; };
ravenConfig.transport.call(sb.Raven, opts);
xhr = xhrs[0];
xhr.readyState = 4; xhr.status = 429; xhr.onreadystatechange();
check('onError received an Error', backoffErr instanceof Error);
check('error.request is the XHR', backoffErr && backoffErr.request === xhr);
check('message names the status', backoffErr && /429/.test(backoffErr.message), backoffErr && backoffErr.message);

console.log('Case 5b: an offline failure carries it too');
sb = makeSandbox();
sb.navigator.onLine = false;
let offErr = null;
opts = transportOptions();
opts.onError = (err) => { offErr = err; };
ravenConfig.transport.call(sb.Raven, opts);
xhr = xhrs[xhrs.length - 1];
xhr.readyState = 4; xhr.status = 0; xhr.onreadystatechange();
check('error.request is the XHR', offErr && offErr.request === xhr);

// --- Case 6: a circular payload must still send
// Raven serialises with json-stringify-safe (`c.send(y(a.data))`). A plain
// JSON.stringify THROWS on a circular structure, and extra context and
// breadcrumbs routinely carry one — a DOM node, an event, an object pointing
// at its own parent. The throw lands between open() and send(), so the report
// is lost and neither completion callback runs.
console.log('Case 6: a circular payload is serialised, not thrown on');
sb = makeSandbox();
opts = transportOptions();
const circular = { msg: 'boom', extra: {} };
circular.extra.self = circular;
opts.data = circular;
let threw = null;
try {
  ravenConfig.transport.call(sb.Raven, opts);
} catch (err) {
  threw = err;
}
check('transport did not throw', !threw, threw && threw.message);
xhr = xhrs[xhrs.length - 1];
check('an XHR was sent', !!xhr && typeof xhr.body === 'string');
check('body marks the cycle', xhr && /\[Circular/.test(xhr.body), xhr && xhr.body);
check('body keeps the real fields', xhr && /"msg":"boom"/.test(xhr.body), xhr && xhr.body);
check('body carries no credential', xhr && xhr.body.indexOf('SECRET') === -1);

console.log('Case 6b: a shared but acyclic reference is NOT reported as circular');
// A flat seen-list would false-positive here: two breadcrumbs pointing at one
// object is a DAG, not a cycle, and the payload should serialise in full.
sb = makeSandbox();
opts = transportOptions();
const shared = { id: 7 };
opts.data = { msg: 'boom', a: shared, b: shared };
ravenConfig.transport.call(sb.Raven, opts);
xhr = xhrs[xhrs.length - 1];
check('no circular marker', xhr.body.indexOf('[Circular') === -1, xhr.body);
check('both references serialised', (xhr.body.match(/"id":7/g) || []).length === 2, xhr.body);

console.log('Case 6c: an ordinary payload serialises exactly as JSON.stringify');
sb = makeSandbox();
opts = transportOptions();
opts.data = { msg: 'boom', nested: { a: 1, b: [1, 2, 3] } };
ravenConfig.transport.call(sb.Raven, opts);
xhr = xhrs[xhrs.length - 1];
check('byte-identical to JSON.stringify', xhr.body === JSON.stringify(opts.data), xhr.body);

console.log(failures ? '\n' + failures + ' FAILING' : '\nALL PASSING');
process.exit(failures ? 1 : 0);
