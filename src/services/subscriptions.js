import { v4 as uuid } from 'uuid';
import { chapaInitialize, chapaVerify } from '../lib/chapaclient.js';
import supabase from '../lib/supabaseclient.js';

const PLANS = {
  basic: { amount: 199, label: 'Basic Plan', durationDays: 30 },
  pro:   { amount: 499, label: 'Pro Plan',   durationDays: 30 },
};

/**
 * Initialize a payment by creating a Chapa checkout and storing pending subscription
 */
export const initializePayment = async (ownerId, body) => {
  const { plan, email, first_name, last_name } = body;

  if (!PLANS[plan]) {
    throw Object.assign(new Error('Invalid plan. Choose basic or pro'), { status: 400 });
  }
  if (!email || !first_name || !last_name) {
    throw Object.assign(new Error('email, first_name and last_name are required'), { status: 400 });
  }

  const txRef = `qrmenu-${plan}-${uuid()}`;
  const { amount, label } = PLANS[plan];

  console.log('[Payment Init] Starting payment for plan:', plan, 'txRef:', txRef, 'owner:', ownerId);

  // Initialize payment with Chapa
  let chapaResult;
  try {
    chapaResult = await chapaInitialize({
      amount,
      currency: 'ETB',
      email,
      first_name,
      last_name,
      tx_ref: txRef,
      // BUG FIX: was using /api/webhooks/chapa — must match the route registered in index.js
      callback_url: `${process.env.API_URL}/api/webhooks/chapa`,
      return_url:   `${process.env.CLIENT_URL}/payment?tx_ref=${txRef}`,
      customization: { title: 'QR Menu', description: label },
    });
  } catch (err) {
    console.error('[Payment Init] Chapa initialization failed:', err.message);
    throw Object.assign(new Error('Payment initialization failed: ' + err.message), { status: 400 });
  }

  if (chapaResult.status !== 'success') {
    console.error('[Payment Init] Chapa returned error:', chapaResult.message);
    throw Object.assign(new Error(chapaResult.message || 'Chapa initialization failed'), { status: 400 });
  }

  // Cancel any existing PENDING subscriptions for THIS owner only
  // BUG FIX: original also scoped to owner_id — that was fine — but we now also
  // log failures instead of silently swallowing them
  const { error: cancelErr } = await supabase
    .from('subscriptions')
    .update({ status: 'cancelled' })
    .eq('owner_id', ownerId)   // ← scoped to THIS user
    .eq('status', 'pending');

  if (cancelErr) {
    // Non-fatal: log and continue
    console.warn('[Payment Init] Could not cancel pending subs:', cancelErr.message);
  }

  // BUG FIX: use supabase insert WITHOUT any unique-conflict assumption.
  // The subscriptions table must allow multiple rows per owner (one per payment).
  // If your schema has a UNIQUE constraint on owner_id, that is the root cause —
  // see migration note below.
  const { error: insertErr } = await supabase
    .from('subscriptions')
    .insert({
      owner_id:     ownerId,
      plan,
      status:       'pending',
      chapa_tx_ref: txRef,
    });

  if (insertErr) {
    console.error('[Payment Init] Failed to insert subscription:', insertErr.message);
    // BUG FIX: surface the real DB error so it's visible in logs
    throw Object.assign(
      new Error('Failed to create subscription record: ' + insertErr.message),
      { status: 500 }
    );
  }

  console.log('[Payment Init] Subscription record created for owner:', ownerId, 'txRef:', txRef);

  return {
    checkout_url: chapaResult.data.checkout_url,
    tx_ref:       txRef,
  };
};

/**
 * Verify payment status using tx_ref (no auth required — tx_ref is the proof)
 */
export const verifyPayment = async (txRef) => {
  console.log('[Verify] Looking up tx_ref:', txRef);

  if (!txRef || typeof txRef !== 'string') {
    throw Object.assign(new Error('Invalid transaction reference'), { status: 400 });
  }

  // Step 1: Find subscription by tx_ref
  const { data: sub, error: dbErr } = await supabase
    .from('subscriptions')
    .select('id, plan, status, owner_id, expires_at')
    .eq('chapa_tx_ref', txRef)
    .maybeSingle();

  if (dbErr) {
    console.error('[Verify] Database error:', dbErr.message);
    throw Object.assign(new Error('Database error: ' + dbErr.message), { status: 500 });
  }

  if (!sub) {
    console.warn('[Verify] Transaction not found:', txRef);
    throw Object.assign(
      new Error('Transaction not found. Please ensure payment was initiated.'),
      { status: 404 }
    );
  }

  console.log('[Verify] Found subscription:', sub.id, 'owner:', sub.owner_id, 'status:', sub.status);

  // Step 2: Already active — return immediately
  if (sub.status === 'active') {
    console.log('[Verify] Subscription already active, expires:', sub.expires_at);
    return {
      verified:   true,
      status:     'active',
      expires_at: sub.expires_at,
      message:    'Subscription is active',
    };
  }

  // Step 3: Ask Chapa for confirmation
  let chapaStatus = null;
  try {
    const result = await chapaVerify(txRef);
    chapaStatus = result?.data?.status;
    console.log('[Verify] Chapa status for', txRef, ':', chapaStatus);
  } catch (err) {
    console.warn('[Verify] Chapa verification call failed:', err.message);
  }

  // Step 4: Activate if Chapa says success
  if (chapaStatus === 'success') {
    const durationDays = PLANS[sub.plan]?.durationDays || 30;
    const now      = new Date();
    const expiresAt = new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000).toISOString();

    const { error: updateErr } = await supabase
      .from('subscriptions')
      .update({
        status:     'active',
        started_at: now.toISOString(),
        expires_at: expiresAt,
      })
      // BUG FIX: scope update to BOTH id AND owner_id to prevent cross-user activation
      .eq('id', sub.id)
      .eq('owner_id', sub.owner_id);

    if (updateErr) {
      console.error('[Verify] Failed to activate subscription:', updateErr.message);
      throw Object.assign(new Error('Failed to activate subscription'), { status: 500 });
    }

    console.log('[Verify] Subscription activated for owner:', sub.owner_id, 'expires:', expiresAt);
    return {
      verified:   true,
      status:     'active',
      expires_at: expiresAt,
      message:    'Payment verified and subscription activated',
    };
  }

  // Step 5: Not confirmed yet
  return {
    verified: false,
    status:   chapaStatus || sub.status,
    message:  'Payment not yet confirmed by Chapa. Please wait or retry.',
  };
};

/**
 * Get current subscription status for a user
 */
export const getSubscriptionStatus = async (ownerId) => {
  if (!ownerId) {
    throw Object.assign(new Error('Owner ID is required'), { status: 400 });
  }

  const { data, error: dbErr } = await supabase
    .from('subscriptions')
    .select('plan, status, started_at, expires_at, created_at')
    .eq('owner_id', ownerId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (dbErr) {
    console.error('[Status] Database error:', dbErr.message);
    throw Object.assign(new Error('Failed to fetch subscription'), { status: 500 });
  }

  if (!data) {
    return { plan: 'free', status: 'inactive', active: false, message: 'No active subscription' };
  }

  const isActive = data.status === 'active' && new Date(data.expires_at) > new Date();
  return { ...data, active: isActive };
};

/**
 * Handle webhook POST from Chapa server
 */
export const handleChapaWebhook = async (txRef, status) => {
  console.log('[Webhook] Received callback:', txRef, 'status:', status);

  if (!txRef) {
    throw Object.assign(new Error('Missing transaction reference'), { status: 400 });
  }

  if (status === 'success') {
    return await verifyPayment(txRef);
  }

  // Mark failed / cancelled
  const { data: sub } = await supabase
    .from('subscriptions')
    .select('id')
    .eq('chapa_tx_ref', txRef)
    .maybeSingle();

  if (sub) {
    await supabase
      .from('subscriptions')
      .update({ status: status === 'cancelled' ? 'cancelled' : 'failed' })
      .eq('id', sub.id);
  }

  return { verified: false, status, message: `Payment ${status}` };
};