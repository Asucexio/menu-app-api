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

  const txRef = `qrmenu-${plan}-${uuid()}`;
  const { amount, label } = PLANS[plan];

  const apiBase = process.env.API_URL || process.env.RENDER_EXTERNAL_URL;
  const clientBase = process.env.CLIENT_URL;
  if (!apiBase || !clientBase) {
    throw Object.assign(
      new Error('Missing API_URL/RENDER_EXTERNAL_URL or CLIENT_URL environment variables'),
      { status: 500 }
    );
  }

  const result = await chapaInitialize({
    amount, currency: 'ETB', email, first_name, last_name,
    tx_ref: txRef,
    callback_url: `${apiBase}/api/webhooks/chapa`,
    return_url:   `${clientBase}/payment?tx_ref=${txRef}`,
    customization: { title: `QR Menu`, description: '30-day subscription' },
  });

  if (result.status !== 'success') {
    const rawMessage = result?.message;
    const message =
      typeof rawMessage === 'string'
        ? rawMessage
        : rawMessage?.message || JSON.stringify(rawMessage || result);
    throw Object.assign(new Error(`Chapa init failed: ${message}`), { status: 400 });
  }

  const { error: cancelErr } = await supabase.from('subscriptions')
    .update({ status: 'cancelled' })
    .eq('owner_id', ownerId).eq('status', 'pending');
  if (cancelErr) {
    throw Object.assign(new Error(`Failed to cancel pending subscriptions: ${cancelErr.message}`), { status: 500 });
  }

  const { error: insertErr } = await supabase.from('subscriptions')
    .insert({ owner_id: ownerId, plan, status: 'pending', chapa_tx_ref: txRef });
  if (insertErr) {
    throw Object.assign(new Error(`Failed to create pending subscription: ${insertErr.message}`), { status: 500 });
  }

  return { checkout_url: result.data.checkout_url, tx_ref: txRef };
};

// ── No ownerId required — tx_ref is unique and sufficient ────
export const verifyPayment = async (txRef) => {
  console.log('[Verify] Looking up tx_ref:', txRef);

  // Step 1: find in DB by tx_ref alone
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

  // Step 2: already active — return immediately
  if (sub.status === 'active') {
    const { data: fresh } = await supabase.from('subscriptions')
      .update({
        status: 'active',
        started_at: new Date().toISOString(),
        expires_at: expiresAt,
      })
      .eq('id', sub.id);

    return { verified: true, status: 'active', expires_at: expiresAt };
  }

  // Step 5: not confirmed yet
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
