import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { handleApi } from '../api-lib.js';

const originalFetch = globalThis.fetch;
const originalEnv = {
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_PUBLISHABLE_KEY: process.env.SUPABASE_PUBLISHABLE_KEY,
  SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY,
  MAILGUN_DOMAIN: process.env.MAILGUN_DOMAIN,
  MAILGUN_API_KEY: process.env.MAILGUN_API_KEY,
  MAILGUN_FROM: process.env.MAILGUN_FROM,
  PAYSTACK_SECRET_KEY: process.env.PAYSTACK_SECRET_KEY,
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
  PAYSTACK_CALLBACK_URL: process.env.PAYSTACK_CALLBACK_URL,
};

function configureSupabase() {
  process.env.SUPABASE_URL = 'https://shop-test.supabase.co';
  process.env.SUPABASE_PUBLISHABLE_KEY = 'test-publishable-key';
  process.env.SUPABASE_SECRET_KEY = 'test-server-secret';
  delete process.env.MAILGUN_DOMAIN;
  delete process.env.MAILGUN_API_KEY;
  delete process.env.MAILGUN_FROM;
  delete process.env.PAYSTACK_SECRET_KEY;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

test.after(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('newsletter rejects invalid addresses without calling Supabase', async () => {
  configureSupabase();
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error('unexpected database call'); };
  const response = await handleApi(new Request('http://shop.test/api/newsletter', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'bad-address' }),
  }), '/api/newsletter');
  assert.equal(response.status, 400);
  assert.equal(called, false);
});

test('newsletter stores normalized addresses through the restricted Supabase RPC', async () => {
  configureSupabase();
  let captured;
  globalThis.fetch = async (url, options) => {
    captured = { url: String(url), options };
    return jsonResponse(true);
  };
  const response = await handleApi(new Request('http://shop.test/api/newsletter', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: '  Person@Example.com  ' }),
  }), '/api/newsletter');
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { message: 'Thanks for subscribing. Keep an eye on your inbox!' });
  assert.equal(captured.url, 'https://shop-test.supabase.co/rest/v1/rpc/subscribe_newsletter');
  assert.deepEqual(JSON.parse(captured.options.body), { p_email: 'person@example.com' });
  assert.equal(captured.options.headers.apikey, 'test-server-secret');
});

test('product API reads active database inventory and surfaces database errors', async () => {
  configureSupabase();
  let requested;
  globalThis.fetch = async (url) => {
    requested = String(url);
    return jsonResponse([{ id: 41, name: 'Edited live product', category: 'New category', description: 'Current details', image_url: '/fresh.jpg', price_minor: 2345 }]);
  };
  const response = await handleApi(new Request('http://shop.test/api/products'), '/api/products');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), [{ id: 41, name: 'Edited live product', category: 'New category', description: 'Current details', image_url: '/fresh.jpg', price_minor: 2345 }]);
  assert.match(requested, /products\?select=.*active=eq\.true/);

  globalThis.fetch = async () => jsonResponse({ message: 'database unavailable' }, 503);
  const failed = await handleApi(new Request('http://shop.test/api/products'), '/api/products');
  assert.equal(failed.status, 502);
  assert.match((await failed.json()).error, /could not be completed/i);
});

test('Supabase HTTP diagnostics report status and redact provider error details', async () => {
  configureSupabase();
  const previousConsoleError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  globalThis.fetch = async () => jsonResponse({
    code: '42501',
    message: 'permission denied for user@example.test with token eyJprivate.secret.signature and "private value"',
  }, 403);
  try {
    const response = await handleApi(new Request('http://shop.test/api/products'), '/api/products');
    assert.equal(response.status, 502);
    const diagnostic = logged.find(([label]) => label === 'Supabase HTTP error:')?.[1];
    assert.equal(diagnostic.status, 403);
    assert.equal(diagnostic.code, '42501');
    assert.equal(diagnostic.endpoint, '/rest/v1/products');
    assert.doesNotMatch(diagnostic.message, /user@example\.test|eyJprivate|private value/);
    assert.match(diagnostic.message, /redacted/);
  } finally {
    console.error = previousConsoleError;
  }
});

test('checkout refuses a request without a signed-in bearer token', async () => {
  configureSupabase();
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error('unexpected database call'); };
  const response = await handleApi(new Request('http://shop.test/api/checkout', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: [{ id: 1, qty: 1 }] }),
  }), '/api/checkout');
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, 'Sign in before checkout.');
  assert.equal(called, false);
});

test('checkout verifies the session then creates an order using database catalog pricing', async () => {
  configureSupabase();
  const key = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const path = new URL(String(url)).pathname;
    calls.push({ path, options });
    if (path === '/auth/v1/user') return jsonResponse({ id: 'user-1', email: 'shopper@example.com', user_metadata: { full_name: 'Shopper' } });
    if (path === '/rest/v1/rpc/create_order_idempotent') return jsonResponse([{ id: 42, total_minor: 2500000, created: true }]);
    if (path === '/rest/v1/order_items') return jsonResponse([{ product_name: 'Test meal', unit_price_minor: 1250000, quantity: 2 }]);
    if (path === '/rest/v1/orders') return jsonResponse([]);
    throw new Error(`Unexpected request: ${path}`);
  };
  const response = await handleApi(new Request('http://shop.test/api/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer signed-in-token' },
    body: JSON.stringify({ name: 'Shopper', email: 'spoof@example.com', address: '12 Market Road', idempotencyKey: key, items: [{ id: 1, qty: 1 }, { id: 1, qty: 1 }] }),
  }), '/api/checkout');
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), {
    orderId: 42, total: 2500000, emailSent: false, emailStatus: 'failed', customerName: 'Shopper', email: 'shopper@example.com',
  });
  const authCall = calls.find((call) => call.path === '/auth/v1/user');
  assert.equal(authCall.options.headers.Authorization, 'Bearer signed-in-token');
  const orderCall = calls.find((call) => call.path === '/rest/v1/rpc/create_order_idempotent');
  const orderBody = JSON.parse(orderCall.options.body);
  assert.deepEqual({ ...orderBody, p_checkout_payload_hash: undefined }, {
    p_user_id: 'user-1', p_name: 'Shopper', p_email: 'shopper@example.com', p_address: '12 Market Road',
    p_items: [{ id: 1, qty: 2 }], p_checkout_key: key, p_checkout_payload_hash: undefined,
  });
  assert.match(orderBody.p_checkout_payload_hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(calls.map((call) => call.path), [
    '/auth/v1/user', '/rest/v1/rpc/create_order_idempotent', '/rest/v1/order_items', '/rest/v1/orders',
  ]);
});

test('checkout reports the committed order when order item lookup fails after commit', async () => {
  configureSupabase();
  const key = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === '/auth/v1/user') return jsonResponse({ id: 'user-2', email: 'shopper@example.com' });
    if (path === '/rest/v1/rpc/create_order_idempotent') return jsonResponse([{ id: 81, total_minor: 4300, created: true }]);
    if (path === '/rest/v1/order_items') return jsonResponse({ message: 'temporarily unavailable' }, 503);
    if (path === '/rest/v1/orders') return jsonResponse([]);
    throw new Error(`Unexpected request: ${path}`);
  };
  const response = await handleApi(new Request('http://shop.test/api/checkout', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
    body: JSON.stringify({ address: '12 Market Road', idempotencyKey: key, items: [{ id: 3, qty: 1 }] }),
  }), '/api/checkout');
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), {
    orderId: 81, total: 4300, emailSent: false, emailStatus: 'failed', customerName: 'shopper', email: 'shopper@example.com',
  });
});

test('checkout retry returns the existing order without sending another confirmation', async () => {
  configureSupabase();
  let itemLookups = 0;
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === '/auth/v1/user') return jsonResponse({ id: 'user-3', email: 'shopper@example.com' });
    if (path === '/rest/v1/rpc/create_order_idempotent') return jsonResponse([{ id: 91, total_minor: 1200, created: false }]);
    if (path === '/rest/v1/orders') return jsonResponse([{ confirmation_email_status: 'sent' }]);
    if (path === '/rest/v1/order_items') { itemLookups++; return jsonResponse([]); }
    throw new Error(`Unexpected request: ${path}`);
  };
  const response = await handleApi(new Request('http://shop.test/api/checkout', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
    body: JSON.stringify({ address: '12 Market Road', idempotencyKey: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', items: [{ id: 4, qty: 1 }] }),
  }), '/api/checkout');
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), {
    orderId: 91, total: 1200, emailSent: true, emailStatus: 'sent', customerName: 'shopper', email: 'shopper@example.com',
  });
  assert.equal(itemLookups, 0);
});

test('checkout accepts quantity 100 and rejects quantity 101 before creating an order', async () => {
  configureSupabase();
  const rpcBodies = [];
  globalThis.fetch = async (url, options) => {
    const path = new URL(String(url)).pathname;
    if (path === '/auth/v1/user') return jsonResponse({ id: 'qty-user', email: 'shopper@example.com' });
    if (path === '/rest/v1/rpc/create_order_idempotent') {
      rpcBodies.push(JSON.parse(options.body));
      return jsonResponse([{ id: 101, total_minor: 10000, created: true }]);
    }
    if (path === '/rest/v1/order_items') return jsonResponse([]);
    if (path === '/rest/v1/orders') return jsonResponse([]);
    throw new Error(`Unexpected request: ${path}`);
  };
  const submit = (qty, idempotencyKey) => handleApi(new Request('http://shop.test/api/checkout', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
    body: JSON.stringify({ address: '12 Market Road', idempotencyKey, items: [{ id: 1, qty }] }),
  }), '/api/checkout');
  const accepted = await submit(100, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd');
  assert.equal(accepted.status, 201);
  assert.equal(rpcBodies[0].p_items[0].qty, 100);
  const rejected = await submit(101, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
  assert.equal(rejected.status, 400);
  assert.match((await rejected.json()).error, /quantity cannot exceed 100/i);
  assert.equal(rpcBodies.length, 1);
});

test('checkout rejects a retry key reused with changed order details', async () => {
  configureSupabase();
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === '/auth/v1/user') return jsonResponse({ id: 'changed-user', email: 'shopper@example.com' });
    if (path === '/rest/v1/rpc/create_order_idempotent') return jsonResponse({ code: 'P0001', message: 'Checkout idempotency key was reused with different order details' }, 400);
    throw new Error(`Unexpected request: ${path}`);
  };
  const response = await handleApi(new Request('http://shop.test/api/checkout', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
    body: JSON.stringify({ name: 'Different name', address: 'Changed address', idempotencyKey: 'abababab-abab-4bab-8bab-abababababab', items: [{ id: 1, qty: 1 }] }),
  }), '/api/checkout');
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /already used for different order details/i);
});

test('public forms reject honeypot submissions before calling Supabase', async () => {
  configureSupabase();
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('should not call storage'); };
  for (const route of ['/api/contact', '/api/newsletter', '/api/bookings', '/api/training-enrollments']) {
    const response = await handleApi(new Request(`http://shop.test${route}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ website: 'bot-filled' }),
    }), route);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'Request could not be processed.');
  }
  assert.equal(calls, 0);
});

test('duplicate newsletter submissions do not create duplicate subscriber records', async () => {
  configureSupabase();
  const stored = new Set();
  let insertCount = 0;
  globalThis.fetch = async (_url, options) => {
    const { p_email: email } = JSON.parse(options.body);
    if (!stored.has(email)) { stored.add(email); insertCount++; }
    return jsonResponse(true);
  };
  for (let n = 0; n < 2; n++) {
    const response = await handleApi(new Request('http://shop.test/api/newsletter', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'same@example.com' }),
    }), '/api/newsletter');
    assert.equal(response.status, 201);
  }
  assert.equal(insertCount, 1);
});

test('second training instalment is rejected until the first is verified', async () => {
  configureSupabase();
  let paystackCalls = 0;
  const tokenHash = createHash('sha256').update('training-token').digest('hex');
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname.endsWith('/training_enrollments')) return jsonResponse([{ id: 7, email: 'learner@example.com', payment_token_hash: tokenHash }]);
    if (parsed.pathname.endsWith('/training_payments') && parsed.searchParams.get('installment_number') === 'eq.2') return jsonResponse([{ id: 22, amount_minor: 5000, status: 'due' }]);
    if (parsed.pathname.endsWith('/training_payments') && parsed.searchParams.get('installment_number') === 'eq.1') return jsonResponse([{ status: 'pending' }]);
    if (parsed.hostname === 'api.paystack.co') paystackCalls++;
    throw new Error(`Unexpected request: ${parsed.pathname}${parsed.search}`);
  };
  const response = await handleApi(new Request('http://shop.test/api/training-payments/initialize', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enrollmentId: 7, installmentNumber: 2, paymentToken: 'training-token' }),
  }), '/api/training-payments/initialize');
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /first instalment must be verified/i);
  assert.equal(paystackCalls, 0);
});

test('second instalment is accepted after server verification marks the first paid', async () => {
  configureSupabase();
  process.env.PAYSTACK_SECRET_KEY = 'test-paystack-secret';
  const tokenHash = createHash('sha256').update('training-token').digest('hex');
  const state = { first: { id: 11, enrollment_id: 7, installment_number: 1, amount_minor: 5000, status: 'pending', payment_reference: 'first-ref' }, secondStatus: 'due', paystackInits: 0 };
  globalThis.fetch = async (url, options) => {
    const parsed = new URL(String(url));
    const query = parsed.searchParams;
    if (parsed.hostname === 'api.paystack.co' && parsed.pathname === '/transaction/verify/first-ref') {
      return jsonResponse({ status: true, data: { status: 'success', amount: 5000, currency: 'NGN', reference: 'first-ref' } });
    }
    if (parsed.hostname === 'api.paystack.co' && parsed.pathname === '/transaction/initialize') {
      state.paystackInits++;
      const requestBody = JSON.parse(options.body);
      return jsonResponse({ status: true, data: { authorization_url: 'https://paystack.test/checkout', reference: requestBody.reference } });
    }
    if (parsed.pathname.endsWith('/training_payments') && options.method === 'GET' && query.has('payment_reference')) return jsonResponse([state.first]);
    if (parsed.pathname.endsWith('/training_payments') && options.method === 'GET' && query.get('installment_number') === 'eq.2') return jsonResponse([{ id: 22, amount_minor: 5000, status: state.secondStatus, payment_reference: null }]);
    if (parsed.pathname.endsWith('/training_payments') && options.method === 'GET' && query.get('installment_number') === 'eq.1') return jsonResponse([{ status: state.first.status }]);
    if (parsed.pathname.endsWith('/training_payments') && options.method === 'GET' && query.get('payment_reference')) return jsonResponse([state.first]);
    if (parsed.pathname.endsWith('/training_enrollments')) return jsonResponse([{ id: 7, email: 'learner@example.com', payment_token_hash: tokenHash }]);
    if (parsed.pathname.endsWith('/training_payments') && options.method === 'PATCH' && query.get('status') === 'neq.paid') { state.first.status = 'paid'; return jsonResponse([state.first]); }
    if (parsed.pathname.endsWith('/training_enrollments') && options.method === 'PATCH') return jsonResponse([{ id: 7 }]);
    if (parsed.pathname.endsWith('/training_payments') && options.method === 'PATCH' && query.get('status') === 'eq.due') { state.secondStatus = 'initializing'; return jsonResponse([{ id: 22 }]); }
    if (parsed.pathname.endsWith('/training_payments') && options.method === 'PATCH' && query.has('payment_reference')) { state.secondStatus = 'pending'; return jsonResponse([{ id: 22 }]); }
    throw new Error(`Unexpected request: ${options.method} ${parsed.pathname}${parsed.search}`);
  };

  const verified = await handleApi(new Request('http://shop.test/api/training-payments/verify', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reference: 'first-ref', paymentToken: 'training-token' }),
  }), '/api/training-payments/verify');
  assert.equal(verified.status, 200);
  assert.equal(state.first.status, 'paid');

  const initialized = await handleApi(new Request('http://shop.test/api/training-payments/initialize', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enrollmentId: 7, installmentNumber: 2, paymentToken: 'training-token' }),
  }), '/api/training-payments/initialize');
  assert.equal(initialized.status, 200);
  assert.equal(state.paystackInits, 1);
  assert.equal(state.secondStatus, 'pending');
});

test('verification retry repairs enrollment status when the payment row is already paid', async () => {
  configureSupabase();
  const tokenHash = createHash('sha256').update('training-token').digest('hex');
  let enrollmentWasUpdated = false;
  globalThis.fetch = async (url, options) => {
    const parsed = new URL(String(url));
    if (parsed.pathname.endsWith('/training_payments') && options.method === 'GET') {
      if (parsed.searchParams.has('payment_reference')) return jsonResponse([{ id: 11, enrollment_id: 7, installment_number: 1, amount_minor: 5000, status: 'paid', payment_reference: 'first-ref' }]);
      return jsonResponse([{ amount_minor: 5000, status: 'due' }]);
    }
    if (parsed.pathname.endsWith('/training_enrollments') && options.method === 'GET') return jsonResponse([{ id: 7, payment_token_hash: tokenHash }]);
    if (parsed.pathname.endsWith('/training_enrollments') && options.method === 'PATCH') { enrollmentWasUpdated = true; return jsonResponse([{ id: 7 }]); }
    throw new Error(`Unexpected request: ${options.method} ${parsed.pathname}${parsed.search}`);
  };
  const response = await handleApi(new Request('http://shop.test/api/training-payments/verify', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reference: 'first-ref', paymentToken: 'training-token' }),
  }), '/api/training-payments/verify');
  assert.equal(response.status, 200);
  assert.equal(enrollmentWasUpdated, true);
});

test('Paystack initialization timeout leaves the attempt locked against duplicate initialization', async () => {
  configureSupabase();
  process.env.PAYSTACK_SECRET_KEY = 'test-paystack-secret';
  const tokenHash = createHash('sha256').update('training-token').digest('hex');
  let status = 'due';
  let paystackCalls = 0;
  globalThis.fetch = async (url, options) => {
    const parsed = new URL(String(url));
    if (parsed.pathname.endsWith('/training_enrollments')) return jsonResponse([{ id: 7, email: 'learner@example.com', payment_token_hash: tokenHash }]);
    if (parsed.pathname.endsWith('/training_payments') && options.method === 'GET') return jsonResponse([{ id: 22, amount_minor: 5000, status }]);
    if (parsed.pathname.endsWith('/training_payments') && options.method === 'PATCH') { status = 'initializing'; return jsonResponse([{ id: 22 }]); }
    if (parsed.hostname === 'api.paystack.co') { paystackCalls++; const error = new Error('timeout'); error.name = 'TimeoutError'; throw error; }
    throw new Error(`Unexpected request: ${parsed.pathname}${parsed.search}`);
  };
  const request = () => new Request('http://shop.test/api/training-payments/initialize', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enrollmentId: 7, installmentNumber: 1, paymentToken: 'training-token' }),
  });
  const firstAttempt = await handleApi(request(), '/api/training-payments/initialize');
  assert.equal(firstAttempt.status, 503);
  assert.match((await firstAttempt.json()).error, /check payment status/i);
  const retry = await handleApi(request(), '/api/training-payments/initialize');
  assert.equal(retry.status, 409);
  assert.equal(paystackCalls, 1);
});

test('training initialization defaults its callback to the moved storefront route', async () => {
  configureSupabase();
  process.env.PAYSTACK_SECRET_KEY = 'test-paystack-secret';
  process.env.PUBLIC_BASE_URL = 'https://zammathconsulting.com';
  delete process.env.PAYSTACK_CALLBACK_URL;
  const tokenHash = createHash('sha256').update('training-token').digest('hex');
  let callbackUrl;
  globalThis.fetch = async (url, options) => {
    const parsed = new URL(String(url));
    if (parsed.pathname.endsWith('/training_enrollments') && options.method === 'GET') return jsonResponse([{ id: 7, email: 'learner@example.com', payment_token_hash: tokenHash }]);
    if (parsed.pathname.endsWith('/training_payments') && options.method === 'GET') return jsonResponse([{ id: 22, amount_minor: 5000, status: 'due' }]);
    if (parsed.pathname.endsWith('/training_payments') && options.method === 'PATCH' && parsed.searchParams.get('status') === 'eq.due') return jsonResponse([{ id: 22 }]);
    if (parsed.hostname === 'api.paystack.co' && parsed.pathname === '/transaction/initialize') {
      const requestBody = JSON.parse(options.body);
      callbackUrl = requestBody.callback_url;
      return jsonResponse({ status: true, data: { authorization_url: 'https://paystack.test/checkout', reference: requestBody.reference } });
    }
    if (parsed.pathname.endsWith('/training_payments') && options.method === 'PATCH') return jsonResponse([{ id: 22 }]);
    throw new Error(`Unexpected request: ${options.method} ${parsed.pathname}${parsed.search}`);
  };
  const response = await handleApi(new Request('http://shop.test/api/training-payments/initialize', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enrollmentId: 7, installmentNumber: 1, paymentToken: 'training-token' }),
  }), '/api/training-payments/initialize');
  assert.equal(response.status, 200);
  assert.equal(callbackUrl, 'https://zammathconsulting.com/zamac-fuds/?training_payment=verify');
});

test('Mailgun timeout does not change a saved order into a checkout failure', async () => {
  configureSupabase();
  process.env.MAILGUN_DOMAIN = 'mail.example.test';
  process.env.MAILGUN_API_KEY = 'test-mailgun-key';
  let mailgunTimeout = false;
  globalThis.fetch = async (url, options) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === '/auth/v1/user') return jsonResponse({ id: 'mail-user', email: 'shopper@example.com' });
    if (parsed.pathname === '/rest/v1/rpc/create_order_idempotent') return jsonResponse([{ id: 202, total_minor: 2000, created: true }]);
    if (parsed.pathname === '/rest/v1/order_items') return jsonResponse([{ product_name: 'Meal', unit_price_minor: 2000, quantity: 1 }]);
    if (parsed.pathname === '/rest/v1/orders') return jsonResponse([]);
    if (parsed.hostname === 'api.mailgun.net') {
      mailgunTimeout = options.signal instanceof AbortSignal;
      const error = new Error('timeout'); error.name = 'TimeoutError'; throw error;
    }
    throw new Error(`Unexpected request: ${parsed.pathname}`);
  };
  const response = await handleApi(new Request('http://shop.test/api/checkout', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
    body: JSON.stringify({ address: '12 Market Road', idempotencyKey: 'ffffffff-ffff-4fff-8fff-ffffffffffff', items: [{ id: 2, qty: 1 }] }),
  }), '/api/checkout');
  assert.equal(response.status, 201);
  const result = await response.json();
  assert.equal(result.orderId, 202);
  assert.equal(result.emailStatus, 'failed');
  assert.equal(mailgunTimeout, true);
});
