import crypto from 'crypto';
import { Router } from 'express';
import supabase from '../lib/supabaseclient.js';

const r = Router();

r.post('/', async (req, res) => {
  try {
    const rawBody = req.body.toString();

    // ── 1. Log everything for debugging ──────────────────────
    console.log('[Chapa Webhook] Headers:', JSON.stringify(req.headers));
    console.log('[Chapa Webhook] Raw body:', rawBody);

    // ── 2. Verify signature (Chapa uses different headers) ───
    const signature =
      req.headers['x-chapa-signature'] ||
      req.headers['chapa-signature']   ||
      req.headers['x-chapa-key'];

    if (signature && process.env.CHAPA_WEBHOOK_SECRET) {
      const expected = crypto
        .createHmac('sha256', process.env.CHAPA_WEBHOOK_SECRET)
        .update(req.body)
        .digest('hex');

      if (signature !== expected) {
        console.warn('[Chapa Webhook] Signature mismatch');
        console.warn('  received :', signature);
        console.warn('  expected :', expected);
        // Block in production, allow in dev so you can test
        if (process.env.NODE_ENV === 'production') {
          return res.status(401).json({ error: 'Invalid signature' });
        }
        console.warn('[Chapa Webhook] Continuing in dev mode despite mismatch');
      } else {
        console.log('[Chapa Webhook] Signature verified OK');
      }
    } else {
      console.warn('[Chapa Webhook] No signature header — skipping verification');
    }

    // ── 3. Parse event ───────────────────────────────────────
    const event = JSON.parse(rawBody);
    console.log('[Chapa Webhook] Event status:', event.status, '| tx_ref:', event.tx_ref);

    // ── 4. Activate subscription on success ──────────────────
    if (event.status === 'success' && event.tx_ref) {
      const { data: sub, error: findErr } = await supabase
        .from('subscriptions')
        .select('id, plan, status')
        .eq('chapa_tx_ref', event.tx_ref)
        .single();

      if (findErr || !sub) {
        console.warn('[Chapa Webhook] No subscription found for tx_ref:', event.tx_ref);
      } else if (sub.status === 'active') {
        console.log('[Chapa Webhook] Already active — skipping:', sub.id);
      } else {
        const expiresAt = new Date(
          Date.now() + 30 * 24 * 60 * 60 * 1000
        ).toISOString();

        const { error: updateErr } = await supabase
          .from('subscriptions')
          .update({
            status: 'active',
            started_at: new Date().toISOString(),
            expires_at: expiresAt,
          })
          .eq('id', sub.id);

        if (updateErr) {
          console.error('[Chapa Webhook] DB update failed:', updateErr.message);
        } else {
          console.log('[Chapa Webhook] ✅ Subscription activated:', sub.id, '| expires:', expiresAt);
        }
      }
    }

    // Always 200 so Chapa doesn't retry
    res.sendStatus(200);
  } catch (err) {
    console.error('[Chapa Webhook] Unexpected error:', err.message);
    res.sendStatus(200);
  }
});

export default r;


