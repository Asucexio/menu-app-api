import { v4 as uuid } from 'uuid';
import { chapaInitialize, chapaVerify } from '../lib/chapaclient.js';
import supabase from '../lib/supabaseclient.js';

const PLANS = {
  basic: { amount: 199, label: 'Basic Plan', durationDays: 30 },
  pro:   { amount: 499, label: 'Pro Plan',   durationDays: 30 },
};

export const initializePayment = async (ownerId, body) => {
  const { plan, email, first_name, last_name } = body;

  if (!PLANS[plan])
    throw Object.assign(new Error('Invalid plan. Choose basic or pro'), { status: 400 });
  if (!email || !first_name || !last_name)
    throw Object.assign(new Error('email, first_name and last_name are required'), { status: 400 });

  // ── Validate env vars before calling Chapa ──────────────────
  const clientUrl = (process.env.CLIENT_URL || '').replace(/\/$/, '');
  const apiUrl    = (process.env.API_URL    || '').replace(/\/$/, '');

  if (!clientUrl || !clientUrl.startsWith('http')) {
    throw Object.assign(
      new Error(
        `CLIENT_URL is not set or invalid: "${clientUrl}". ` +
        `Add it in your Render environment variables. ` +
        `Example: https://your-app.vercel.app`
      ),
      { status: 500 }
    );
  }

  if (!apiUrl || !apiUrl.startsWith('http')) {
    throw Object.assign(
      new Error(
        `API_URL is not set or invalid: "${apiUrl}". ` +
        `Add it in your Render environment variables. ` +
        `Example: https://your-api.onrender.com`
      ),
      { status: 500 }
    );
  }

  const txRef = `qrmenu-${plan}-${uuid()}`;
  const { amount, label } = PLANS[plan];

  const returnUrl   = `${clientUrl}/payment?tx_ref=${txRef}`;
  const callbackUrl = `${apiUrl}/api/webhooks/chapa`;

  console.log('[Subscription] return_url  :', returnUrl);
  console.log('[Subscription] callback_url:', callbackUrl);

  const result = await chapaInitialize({
    amount,
    currency: 'ETB',
    email,
    first_name,
    last_name,
    tx_ref: txRef,
    callback_url: callbackUrl,
    return_url:   returnUrl,
    customization: {
      title: `QR Menu — ${label}`,
      description: '30-day subscription',
    },
  });

  if (result.status !== 'success')
    throw Object.assign(
      new Error(`Chapa init failed: ${JSON.stringify(result.message || result.validation_errors)}`),
      { status: 400 }
    );

  // cancel previous pending
  await supabase.from('subscriptions')
    .update({ status: 'cancelled' })
    .eq('owner_id', ownerId)
    .eq('status', 'pending');

  await supabase.from('subscriptions')
    .insert({ owner_id: ownerId, plan, status: 'pending', chapa_tx_ref: txRef });

  return { checkout_url: result.data.checkout_url, tx_ref: txRef };
};

// ── Verify — public, tx_ref is enough ───────────────────────
export const verifyPayment = async (txRef) => {
  console.log('[Verify] Looking up tx_ref:', txRef);

  const { data: sub, error: dbErr } = await supabase
    .from('subscriptions')
    .select('id, plan, status, owner_id')
    .eq('chapa_tx_ref', txRef)
    .single();

  if (dbErr || !sub) {
    console.error('[Verify] Not found in DB:', dbErr?.message);
    throw Object.assign(new Error('Transaction not found'), { status: 404 });
  }

  console.log('[Verify] DB subscription status:', sub.status);

  if (sub.status === 'active') {
    const { data: fresh } = await supabase
      .from('subscriptions').select('expires_at').eq('id', sub.id).single();
    return { verified: true, status: 'active', expires_at: fresh?.expires_at };
  }

  let chapaStatus = null;
  try {
    const result = await chapaVerify(txRef);
    chapaStatus = result?.data?.status;
    console.log('[Verify] Chapa status:', chapaStatus);
  } catch (err) {
    console.warn('[Verify] Chapa call failed:', err.message);
  }

  if (chapaStatus === 'success') {
    const durationDays = PLANS[sub.plan]?.durationDays || 30;
    const expiresAt = new Date(
      Date.now() + durationDays * 24 * 60 * 60 * 1000
    ).toISOString();

    await supabase.from('subscriptions')
      .update({
        status: 'active',
        started_at: new Date().toISOString(),
        expires_at: expiresAt,
      })
      .eq('id', sub.id);

    return { verified: true, status: 'active', expires_at: expiresAt };
  }

  return {
    verified: false,
    status: chapaStatus || sub.status,
    message: 'Payment not yet confirmed by Chapa.',
  };
};

export const getSubscriptionStatus = async (ownerId) => {
  const { data } = await supabase
    .from('subscriptions')
    .select('plan, status, started_at, expires_at, created_at')
    .eq('owner_id', ownerId)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (!data) return { plan: 'free', status: 'inactive', active: false };
  const active = data.status === 'active' && new Date(data.expires_at) > new Date();
  return { ...data, active };
};