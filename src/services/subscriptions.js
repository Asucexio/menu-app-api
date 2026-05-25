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
  
  // Validate plan
  if (!PLANS[plan]) {
    throw Object.assign(
      new Error('Invalid plan. Choose basic or pro'),
      { status: 400 }
    );
  }
  
  // Validate required fields
  if (!email || !first_name || !last_name) {
    throw Object.assign(
      new Error('email, first_name and last_name are required'),
      { status: 400 }
    );
  }

  const txRef = `qrmenu-${plan}-${uuid()}`;
  const { amount, label } = PLANS[plan];

  console.log('[Payment Init] Starting payment for plan:', plan, 'txRef:', txRef);

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
      callback_url: `${process.env.API_URL}/api/webhooks/chapa`,
      return_url: `${process.env.CLIENT_URL}/payment?tx_ref=${txRef}`,
      customization: {
        title: 'QR Menu',
        description: label,
      },
    });
  } catch (err) {
    console.error('[Payment Init] Chapa initialization failed:', err.message);
    throw Object.assign(
      new Error('Payment initialization failed: ' + err.message),
      { status: 400 }
    );
  }

  if (chapaResult.status !== 'success') {
    console.error('[Payment Init] Chapa returned error:', chapaResult.message);
    throw Object.assign(
      new Error(chapaResult.message || 'Chapa initialization failed'),
      { status: 400 }
    );
  }

  console.log('[Payment Init] Chapa checkout created:', txRef);

  // Cancel any existing pending subscriptions
  try {
    await supabase
      .from('subscriptions')
      .update({ status: 'cancelled' })
      .eq('owner_id', ownerId)
      .eq('status', 'pending');
    
    console.log('[Payment Init] Cancelled existing pending subscriptions');
  } catch (err) {
    console.warn('[Payment Init] Failed to cancel pending subscriptions:', err.message);
  }

  // Create new pending subscription
  try {
    const { error: insertErr } = await supabase
      .from('subscriptions')
      .insert({
        owner_id: ownerId,
        plan,
        status: 'pending',
        chapa_tx_ref: txRef,
      });

    if (insertErr) {
      console.error('[Payment Init] Failed to insert subscription:', insertErr.message);
      throw Object.assign(
        new Error('Failed to create subscription record'),
        { status: 500 }
      );
    }

    console.log('[Payment Init] Subscription record created:', txRef);
  } catch (err) {
    console.error('[Payment Init] Insert error:', err.message);
    throw err;
  }

  return {
    checkout_url: chapaResult.data.checkout_url,
    tx_ref: txRef,
  };
};

/**
 * Verify payment status using tx_ref (no auth required)
 * This is called after user returns from Chapa or from webhook
 */
export const verifyPayment = async (txRef) => {
  console.log('[Verify] Looking up tx_ref:', txRef);

  if (!txRef || typeof txRef !== 'string') {
    throw Object.assign(
      new Error('Invalid transaction reference'),
      { status: 400 }
    );
  }

  // Step 1: Find subscription by tx_ref (use maybeSingle for safety)
  let sub;
  try {
    const { data, error: dbErr } = await supabase
      .from('subscriptions')
      .select('id, plan, status, owner_id, expires_at')
      .eq('chapa_tx_ref', txRef)
      .maybeSingle(); // Use maybeSingle instead of single() — returns null if not found

    if (dbErr) {
      console.error('[Verify] Database error:', dbErr.message);
      throw Object.assign(
        new Error('Database error: ' + dbErr.message),
        { status: 500 }
      );
    }

    if (!data) {
      console.warn('[Verify] Transaction not found in database:', txRef);
      throw Object.assign(
        new Error('Transaction not found. Please ensure payment was initiated.'),
        { status: 404 }
      );
    }

    sub = data;
    console.log('[Verify] Found subscription:', sub.id, 'status:', sub.status);
  } catch (err) {
    if (err.status) throw err; // Re-throw if already has status code
    console.error('[Verify] Unexpected error:', err.message);
    throw Object.assign(
      new Error('Failed to verify transaction'),
      { status: 500 }
    );
  }

  // Step 2: Already active — return immediately
  if (sub.status === 'active') {
    console.log('[Verify] Subscription already active, expires:', sub.expires_at);
    return {
      verified: true,
      status: 'active',
      expires_at: sub.expires_at,
      message: 'Subscription is active',
    };
  }

  // Step 3: Check with Chapa for payment confirmation
  let chapaStatus = null;
  try {
    const result = await chapaVerify(txRef);
    chapaStatus = result?.data?.status;
    console.log('[Verify] Chapa status:', chapaStatus);
  } catch (err) {
    console.warn('[Verify] Chapa verification call failed:', err.message);
    // Don't throw — continue with what we know
  }

  // Step 4: Activate subscription if Chapa confirms payment
  if (chapaStatus === 'success') {
    console.log('[Verify] Payment confirmed by Chapa, activating subscription');

    const durationDays = PLANS[sub.plan]?.durationDays || 30;
    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + durationDays * 24 * 60 * 60 * 1000
    ).toISOString();

    try {
      const { error: updateErr } = await supabase
        .from('subscriptions')
        .update({
          status: 'active',
          started_at: now.toISOString(),
          expires_at: expiresAt,
        })
        .eq('id', sub.id);

      if (updateErr) {
        console.error('[Verify] Failed to activate subscription:', updateErr.message);
        throw Object.assign(
          new Error('Failed to activate subscription'),
          { status: 500 }
        );
      }

      console.log('[Verify] Subscription activated, expires:', expiresAt);
      return {
        verified: true,
        status: 'active',
        expires_at: expiresAt,
        message: 'Payment verified and subscription activated',
      };
    } catch (err) {
      if (err.status) throw err;
      throw Object.assign(
        new Error('Failed to update subscription status'),
        { status: 500 }
      );
    }
  }

  // Step 5: Payment not confirmed yet
  console.log('[Verify] Payment not yet confirmed. Chapa status:', chapaStatus, 'DB status:', sub.status);
  return {
    verified: false,
    status: chapaStatus || sub.status,
    message: 'Payment not yet confirmed by Chapa. Please wait or retry.',
  };
};

/**
 * Get current subscription status for a user
 */
export const getSubscriptionStatus = async (ownerId) => {
  if (!ownerId) {
    throw Object.assign(
      new Error('Owner ID is required'),
      { status: 400 }
    );
  }

  console.log('[Status] Fetching subscription for owner:', ownerId);

  try {
    const { data, error: dbErr } = await supabase
      .from('subscriptions')
      .select('plan, status, started_at, expires_at, created_at')
      .eq('owner_id', ownerId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(); // Use maybeSingle for safety

    if (dbErr) {
      console.error('[Status] Database error:', dbErr.message);
      throw Object.assign(
        new Error('Failed to fetch subscription'),
        { status: 500 }
      );
    }

    // No subscription found — return free plan
    if (!data) {
      console.log('[Status] No subscription found, returning free plan');
      return {
        plan: 'free',
        status: 'inactive',
        active: false,
        message: 'No active subscription',
      };
    }

    // Check if subscription is still active
    const isActive = data.status === 'active' && new Date(data.expires_at) > new Date();

    console.log('[Status] Found subscription:', data.plan, 'active:', isActive);
    return {
      ...data,
      active: isActive,
    };
  } catch (err) {
    if (err.status) throw err;
    console.error('[Status] Unexpected error:', err.message);
    throw Object.assign(
      new Error('Failed to get subscription status'),
      { status: 500 }
    );
  }
};

/**
 * Handle webhook callback from Chapa (called by Chapa server, not user)
 */
export const handleChapaWebhook = async (txRef, status) => {
  console.log('[Webhook] Received callback from Chapa:', txRef, 'status:', status);

  if (!txRef) {
    console.error('[Webhook] Missing tx_ref in webhook');
    throw Object.assign(
      new Error('Missing transaction reference'),
      { status: 400 }
    );
  }

  if (status === 'success') {
    // Verify and activate the payment
    return await verifyPayment(txRef);
  }

  // Handle failure cases
  console.warn('[Webhook] Payment failed or cancelled:', status);
  
  try {
    // Update subscription status to reflect failure
    const { data: sub, error: dbErr } = await supabase
      .from('subscriptions')
      .select('id')
      .eq('chapa_tx_ref', txRef)
      .maybeSingle();

    if (sub && !dbErr) {
      await supabase
        .from('subscriptions')
        .update({ status: status === 'cancelled' ? 'cancelled' : 'failed' })
        .eq('id', sub.id);
    }
  } catch (err) {
    console.warn('[Webhook] Failed to update subscription status:', err.message);
  }

  return {
    verified: false,
    status: status,
    message: `Payment ${status}`,
  };
};