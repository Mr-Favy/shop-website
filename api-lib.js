import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const config = () => ({
  url: (process.env.SUPABASE_URL || '').replace(/\/$/, ''),
  publicKey: process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || '',
  secretKey: process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '',
});

function requireSupabase() {
  const settings = config();
  if (!settings.url || !settings.publicKey || !settings.secretKey) {
    throw new HttpError(503, 'The shop database is not configured. Add SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, and SUPABASE_SECRET_KEY in Vercel, then redeploy.');
  }
  return settings;
}

function sanitizeSupabaseMessage(value) {
  if (typeof value !== 'string') return 'No provider message returned.';
  return value
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sb_secret_|eyJ)[A-Za-z0-9._-]+/g, '[redacted token]')
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[redacted email]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, '[redacted id]')
    .replace(/\bKey\s*\([^)]*\)\s*=\s*\([^)]*\)/gi, 'Key ([redacted])')
    .replace(/'[^']*'|"[^"]*"/g, '"[redacted]"')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 300) || 'No provider message returned.';
}

async function supabase(method, path, payload, { token } = {}) {
  const settings = requireSupabase();
  const restPath = path.startsWith('/rest/v1/');
  const key = restPath ? settings.secretKey : settings.publicKey;
  const headers = { apikey: key, 'Content-Type': 'application/json', Prefer: 'return=representation' };
  if (token) headers.Authorization = `Bearer ${token}`;
  else if (!(restPath && key.startsWith('sb_secret_'))) headers.Authorization = `Bearer ${key}`;
  let response;
  try {
    response = await fetch(settings.url + path, {
      method,
      headers,
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      signal: AbortSignal.timeout(12_000),
    });
  } catch (error) {
    const detail = error?.name === 'TimeoutError'
      ? 'The shop database took too long to respond. Please try again.'
      : 'The shop database could not be reached. Check that SUPABASE_URL is correct and the database is online.';
    throw new HttpError(503, detail);
  }
  const raw = await response.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
  if (!response.ok) {
    const detail = typeof data === 'object' && data ? (data.message || data.error_description || data.error) : data;
    const code = typeof data?.code === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(data.code) ? data.code : 'unavailable';
    console.error('Supabase HTTP error:', {
      endpoint: path.split('?')[0],
      status: response.status,
      code,
      message: sanitizeSupabaseMessage(detail),
    });
    if (data?.code === 'P0001' && String(detail).includes('Checkout idempotency key')) {
      throw new HttpError(409, 'This checkout attempt was already used for different order details. Start checkout again.');
    }
    if (data?.code === 'P0001') throw new HttpError(400, 'The request could not be completed. Check the submitted details and try again.');
    throw new HttpError(response.status === 401 ? 401 : 502, 'The request could not be completed. Please try again.');
  }
  return data;
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
}

function rejectHoneypot(payload) {
  if (String(payload.website || '').trim()) throw new HttpError(400, 'Request could not be processed.');
}

async function paystack(method, path, payload) {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) throw new HttpError(503, 'Paystack payments are not configured.');
  let response;
  try {
    response = await fetch(`https://api.paystack.co${path}`, {
      method,
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      signal: AbortSignal.timeout(12_000),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new HttpError(503, 'Paystack did not respond in time. Check payment status before trying again.');
    }
    throw new HttpError(503, 'Paystack could not be reached. Please try again later.');
  }
  let result;
  try { result = await response.json(); } catch { throw new HttpError(502, 'Paystack returned an invalid response.'); }
  if (!response.ok || !result.status) throw new HttpError(502, 'Paystack could not complete the request.');
  return result.data;
}

async function sendOrderEmail(email, name, orderId, totalMinor, items) {
  const domain = process.env.MAILGUN_DOMAIN;
  const apiKey = process.env.MAILGUN_API_KEY;
  const from = process.env.MAILGUN_FROM || (domain ? `Zamac Füds <orders@${domain}>` : '');
  if (!domain || !apiKey || !from) return false;
  const itemLines = items.map(item => `${item.quantity} × ${item.product_name} — ₦${(item.quantity * item.unit_price_minor / 100).toLocaleString('en-NG')}`).join('\n');
  const body = new URLSearchParams({
    from,
    to: email,
    subject: `Your Zamac Füds order #${orderId} is confirmed`,
    text: `Hi ${name},\n\nThanks for your order #${orderId}!\n\n${itemLines}\n\nTotal: ₦${(totalMinor / 100).toLocaleString('en-NG')}\n\nWe’ll be in touch when your food is on its way.\n\nZamac Füds`,
  });
  try {
    const response = await fetch(`https://api.mailgun.net/v3/${domain}/messages`, {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`api:${apiKey}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(12_000),
    });
    return response.ok;
  } catch {
    console.error('Mailgun confirmation failed or timed out.');
    return false;
  }
}

async function trainingEnrollment(payload) {
  rejectHoneypot(payload);
  const name = String(payload.name || '').trim();
  const email = String(payload.email || '').trim().toLowerCase();
  const phone = String(payload.phone || '').trim();
  const program = String(payload.program || '').trim();
  if (!name || name.length > 120 || !validEmail(email)) throw new HttpError(400, 'Enter a valid name and email address.');
  if (!['chef', 'nutrition'].includes(program) || phone.length < 7 || phone.length > 40) {
    throw new HttpError(400, 'Choose a course and enter a valid phone number.');
  }
  const paymentToken = randomBytes(32).toString('base64url');
  const result = await supabase('POST', '/rest/v1/rpc/create_training_enrollment', {
    p_program_code: program,
    p_name: name,
    p_email: email,
    p_phone: phone,
    p_payment_token_hash: hashToken(paymentToken),
  });
  const row = Array.isArray(result) ? result[0] : result;
  if (!row?.enrollment_id) throw new HttpError(502, 'The enrollment request was not saved.');
  return {
    id: row.enrollment_id,
    firstPayment: Number(row.first_payment_minor),
    balance: Number(row.balance_minor),
    total: Number(row.total_minor),
    paymentToken,
  };
}

async function booking(payload) {
  rejectHoneypot(payload);
  const name = String(payload.name || '').trim();
  const email = String(payload.email || '').trim().toLowerCase();
  const phone = String(payload.phone || '').trim();
  const occasion = String(payload.occasion || '').trim();
  const eventDate = String(payload.event_date || '').trim();
  const guestCount = Number(payload.guest_count || 0);
  const smallChops = String(payload.small_chops || '').trim();
  let notes = String(payload.notes || '').trim();
  const budget = String(payload.budget || '').trim();
  const allowed = ['Birthday', 'Wedding', 'Naming ceremony', 'Graduation', 'Corporate event', 'Other celebration'];
  if (!name || name.length > 120 || !validEmail(email)) throw new HttpError(400, 'Enter a valid name and email address.');
  if (phone.length < 7 || phone.length > 40 || !allowed.includes(occasion) || smallChops.length > 160 || notes.length > 1500 || budget.length > 100 || !smallChops) {
    throw new HttpError(400, 'Please check your booking details.');
  }
  if (!Number.isInteger(guestCount) || guestCount < 5 || guestCount > 2000) throw new HttpError(400, 'Bookings are for 5 to 2,000 guests.');
  const isDateString = /^\d{4}-\d{2}-\d{2}$/.test(eventDate);
  const parsedDate = isDateString ? new Date(`${eventDate}T00:00:00Z`) : null;
  if (!parsedDate || Number.isNaN(parsedDate.valueOf()) || parsedDate.toISOString().slice(0, 10) !== eventDate || eventDate < new Date().toISOString().slice(0, 10)) {
    throw new HttpError(400, 'Choose a future event date.');
  }
  if (budget) notes = `Budget: ${budget}${notes ? `\n${notes}` : ''}`;
  const rows = await supabase('POST', '/rest/v1/bookings', { name, email, phone, occasion, event_date: eventDate, guest_count: guestCount, small_chops: smallChops, notes });
  return { id: rows?.[0]?.id, message: 'Booking request received. We’ll contact you to confirm availability and pricing.' };
}

async function contact(payload) {
  rejectHoneypot(payload);
  const name = String(payload.name || '').trim();
  const email = String(payload.email || '').trim().toLowerCase();
  const topic = String(payload.topic || 'General enquiry').trim().slice(0, 80);
  const message = String(payload.message || '').trim();
  if (!name || name.length > 120 || !validEmail(email)) throw new HttpError(400, 'Enter a valid name and email address.');
  if (!message || message.length > 2000) throw new HttpError(400, 'Write a message of up to 2,000 characters.');
  const rows = await supabase('POST', '/rest/v1/contact_messages', { name, email, topic, message });
  return { id: rows?.[0]?.id, message: 'Thanks for writing. Your message is with our team.' };
}

async function subscribeNewsletter(payload) {
  rejectHoneypot(payload);
  const email = String(payload.email || '').trim().toLowerCase();
  if (!validEmail(email)) throw new HttpError(400, 'Enter a valid email address.');
  await supabase('POST', '/rest/v1/rpc/subscribe_newsletter', { p_email: email });
  return { message: 'Thanks for subscribing. Keep an eye on your inbox!' };
}

async function checkout(payload, request) {
  const authorization = request.headers.get('authorization') || '';
  if (!authorization.startsWith('Bearer ')) throw new HttpError(401, 'Sign in before checkout.');
  const accessToken = authorization.slice(7);
  const user = await supabase('GET', '/auth/v1/user', undefined, { token: accessToken });
  const email = String(user.email || '').trim().toLowerCase();
  const userId = user.id;
  if (!email || !userId) throw new HttpError(401, 'Google sign-in is required.');
  const metadata = user.user_metadata || {};
  const name = String(payload.name || metadata.full_name || metadata.name || email.split('@')[0]).trim();
  const address = String(payload.address || '').trim();
  const checkoutKey = String(payload.idempotencyKey || '').trim();
  if (!name || name.length > 120) throw new HttpError(400, 'Enter your name.');
  if (!address || address.length > 500) throw new HttpError(400, 'Enter a delivery address.');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(checkoutKey)) {
    throw new HttpError(400, 'A valid checkout retry key is required. Refresh the checkout and try again.');
  }
  if (!Array.isArray(payload.items) || !payload.items.length || payload.items.length > 50) throw new HttpError(400, 'Your basket is empty.');
  const quantities = new Map();
  for (const item of payload.items) {
    const id = Number(item.id), qty = Number(item.qty);
    if (!Number.isInteger(id) || !Number.isInteger(qty) || id <= 0 || qty <= 0) throw new HttpError(400, 'Invalid cart item.');
    if (qty > 100) throw new HttpError(400, 'A product quantity cannot exceed 100.');
    const totalQuantity = (quantities.get(id) || 0) + qty;
    if (totalQuantity > 100) throw new HttpError(400, 'A product quantity cannot exceed 100.');
    quantities.set(id, totalQuantity);
  }
  const itemsForOrder = [...quantities].map(([id, qty]) => ({ id, qty })).sort((a, b) => a.id - b.id);
  const checkoutPayloadHash = createHash('sha256').update(JSON.stringify({
    userId, name, email, address, items: itemsForOrder,
  })).digest('hex');
  const rpc = await supabase('POST', '/rest/v1/rpc/create_order_idempotent', {
    p_user_id: userId,
    p_name: name,
    p_email: email,
    p_address: address,
    p_items: itemsForOrder,
    p_checkout_key: checkoutKey,
    p_checkout_payload_hash: checkoutPayloadHash,
  });
  const order = Array.isArray(rpc) ? rpc[0] : rpc;
  if (!order?.id) throw new HttpError(502, 'The order was not saved.');
  let emailStatus = 'pending';
  if (order.created) {
    let emailSent = false;
    try {
      const items = await supabase('GET', `/rest/v1/order_items?select=product_name,unit_price_minor,quantity&order_id=eq.${encodeURIComponent(order.id)}`);
      emailSent = await sendOrderEmail(email, name, order.id, Number(order.total_minor), items || []);
      emailStatus = emailSent ? 'sent' : 'failed';
    } catch (error) {
      emailStatus = 'failed';
      console.error('Could not prepare order confirmation email:', error.message);
    }
    try {
      await supabase('PATCH', `/rest/v1/orders?id=eq.${encodeURIComponent(order.id)}`, { confirmation_email_status: emailStatus });
    } catch (error) {
      console.error('Could not update email status:', error.message);
    }
  } else {
    try {
      const savedOrder = await supabase('GET', `/rest/v1/orders?select=confirmation_email_status&id=eq.${encodeURIComponent(order.id)}&user_id=eq.${encodeURIComponent(userId)}`);
      emailStatus = savedOrder?.[0]?.confirmation_email_status || 'pending';
    } catch (error) {
      console.error('Could not read order email status:', error.message);
    }
  }
  return { orderId: order.id, total: Number(order.total_minor), emailSent: emailStatus === 'sent', emailStatus, customerName: name, email };
}

async function initPayment(payload, request) {
  const enrollmentId = Number(payload.enrollmentId);
  const installment = Number(payload.installmentNumber);
  const token = String(payload.paymentToken || '');
  if (!Number.isInteger(enrollmentId) || enrollmentId <= 0 || !token) throw new HttpError(400, 'The training payment details are incomplete.');
  if (![1, 2].includes(installment)) throw new HttpError(400, 'Choose a valid instalment.');
  const enrollments = await supabase('GET', `/rest/v1/training_enrollments?select=id,email,payment_token_hash&id=eq.${enrollmentId}`);
  const payments = await supabase('GET', `/rest/v1/training_payments?select=id,amount_minor,status,payment_reference&enrollment_id=eq.${enrollmentId}&installment_number=eq.${installment}`);
  if (!enrollments?.length || !payments?.length || !safeEqual(enrollments[0].payment_token_hash, hashToken(token))) throw new HttpError(401, 'That training payment link is invalid.');
  const payment = payments[0];
  if (payment.status === 'paid') throw new HttpError(400, 'This instalment has already been paid.');
  if (installment === 2) {
    const first = await supabase('GET', `/rest/v1/training_payments?select=status&enrollment_id=eq.${enrollmentId}&installment_number=eq.1`);
    if (!first?.length || first[0].status !== 'paid') throw new HttpError(409, 'The first instalment must be verified before starting the second payment.');
  }
  if (payment.status !== 'due') throw new HttpError(409, 'A payment attempt is already in progress or needs verification. Check its status before trying again.');
  const reference = `zamac-${randomBytes(20).toString('base64url')}`;
  const claimed = await supabase('PATCH', `/rest/v1/training_payments?id=eq.${payment.id}&status=eq.due`, { status: 'initializing', payment_reference: reference });
  if (!Array.isArray(claimed) || !claimed.length) throw new HttpError(409, 'A payment attempt is already in progress. Check its status before trying again.');
  const host = request.headers.get('host') || 'localhost';
  const base = (process.env.PUBLIC_BASE_URL || `https://${host}`).replace(/\/$/, '');
  const callbackUrl = process.env.PAYSTACK_CALLBACK_URL || `${base}/zamac-fuds/?training_payment=verify`;
  const transaction = await paystack('POST', '/transaction/initialize', {
    email: enrollments[0].email,
    amount: String(payment.amount_minor),
    currency: 'NGN',
    reference,
    callback_url: callbackUrl,
    metadata: { enrollment_id: enrollmentId, installment_number: installment },
  });
  if (!transaction.authorization_url || transaction.reference !== reference) throw new HttpError(502, 'The payment page could not be created.');
  await supabase('PATCH', `/rest/v1/training_payments?id=eq.${payment.id}&payment_reference=eq.${encodeURIComponent(reference)}`, { status: 'pending' });
  return { authorizationUrl: transaction.authorization_url, reference };
}

async function verifyPayment(payload) {
  const reference = String(payload.reference || '');
  const token = String(payload.paymentToken || '');
  if (!reference || reference.length > 120 || !token) throw new HttpError(400, 'The payment reference is missing.');
  const payments = await supabase('GET', `/rest/v1/training_payments?select=id,enrollment_id,installment_number,amount_minor,status,payment_reference&payment_reference=eq.${encodeURIComponent(reference)}`);
  if (!payments?.length) throw new HttpError(401, 'That payment reference was not found.');
  const payment = payments[0];
  const enrollments = await supabase('GET', `/rest/v1/training_enrollments?select=id,payment_token_hash&id=eq.${payment.enrollment_id}`);
  if (!enrollments?.length || !safeEqual(enrollments[0].payment_token_hash, hashToken(token))) throw new HttpError(401, 'That training payment link is invalid.');
  let nextAmount = 0;
  if (payment.status !== 'paid') {
    const verified = await paystack('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
    if (verified.status !== 'success' || Number(verified.amount) !== Number(payment.amount_minor) || verified.currency !== 'NGN' || verified.reference !== reference) {
      return { paid: false, enrollmentId: payment.enrollment_id, installment: payment.installment_number, message: 'Payment has not been confirmed. You can try again.' };
    }
    const saved = await supabase('PATCH', `/rest/v1/training_payments?id=eq.${payment.id}&status=neq.paid`, { status: 'paid', paid_at: new Date().toISOString() });
    if (!Array.isArray(saved) || !saved.length) {
      const current = await supabase('GET', `/rest/v1/training_payments?select=status&id=eq.${payment.id}`);
      if (current?.[0]?.status !== 'paid') throw new HttpError(503, 'Payment was verified but its status could not be saved. Please contact support before retrying.');
    }
  }
  const enrollmentUpdate = await supabase('PATCH', `/rest/v1/training_enrollments?id=eq.${payment.enrollment_id}`, { status: payment.installment_number === 2 ? 'paid' : 'part_paid' });
  if (!Array.isArray(enrollmentUpdate) || !enrollmentUpdate.length) throw new HttpError(503, 'Payment was verified but enrollment status could not be saved. Please contact support.');
  if (payment.installment_number === 1) {
    const next = await supabase('GET', `/rest/v1/training_payments?select=amount_minor,status&enrollment_id=eq.${payment.enrollment_id}&installment_number=eq.2`);
    if (next?.length && next[0].status !== 'paid') nextAmount = Number(next[0].amount_minor);
  }
  return { paid: true, enrollmentId: payment.enrollment_id, installment: payment.installment_number, nextAmount };
}

export async function handleApi(request, route) {
  try {
    if (request.method === 'GET') {
      if (route === '/api/config') {
        const settings = config();
        return Response.json({ supabaseUrl: settings.url, supabaseAnonKey: settings.publicKey, authEnabled: !!(settings.url && settings.publicKey && settings.secretKey), paymentsEnabled: !!process.env.PAYSTACK_SECRET_KEY });
      }
      if (route === '/api/products') {
        const settings = config();
        if (!settings.url || !settings.publicKey || !settings.secretKey) {
          return Response.json({ error: 'The live menu is not configured.' }, { status: 503 });
        }
        const products = await supabase('GET', '/rest/v1/products?select=id,name,category,description,size,badge,image_url,price_minor&active=eq.true&order=id.asc');
        return Response.json(products || []);
      }
      return Response.json({ error: 'Not found' }, { status: 404 });
    }
    if (request.method !== 'POST') return Response.json({ error: 'Method not allowed.' }, { status: 405 });
    const bodyText = await request.text();
    if (bodyText.length > 32_000) throw new HttpError(413, 'Request is too large.');
    let payload;
    try { payload = bodyText ? JSON.parse(bodyText) : {}; } catch { throw new HttpError(400, 'Invalid request body.'); }
    let result;
    if (route === '/api/training-enrollments') result = await trainingEnrollment(payload);
    else if (route === '/api/bookings') result = await booking(payload);
    else if (route === '/api/contact') result = await contact(payload);
    else if (route === '/api/newsletter') result = await subscribeNewsletter(payload);
    else if (route === '/api/checkout') result = await checkout(payload, request);
    else if (route === '/api/training-payments/initialize') result = await initPayment(payload, request);
    else if (route === '/api/training-payments/verify') result = await verifyPayment(payload);
    else return Response.json({ error: 'Not found' }, { status: 404 });
    return Response.json(result, { status: route === '/api/training-payments/initialize' || route === '/api/training-payments/verify' ? 200 : 201 });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    if (status >= 500) console.error('Shop API error:', error);
    const message = error instanceof HttpError ? error.message : 'We could not complete your request. Please try again.';
    return Response.json({ error: message }, { status, headers: { 'Cache-Control': 'no-store' } });
  }
}
