import * as svc from '../services/subscriptions.js';
import { getUserId } from '../middlewares/auth.js';

/**
 * POST /api/subscriptions/initialize
 * Initiate a payment for a plan
 * Requires: Auth token
 * Body: { plan: 'basic' | 'pro', email, first_name, last_name }
 */
export const initialize = async (req, res, next) => {
  try {
    const ownerId = getUserId(req);
    if (!ownerId) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Authentication required',
      });
    }

    console.log('[Controller] Initializing payment for owner:', ownerId);
    const data = await svc.initializePayment(ownerId, req.body);
    
    res.status(200).json({
      success: true,
      ...data,
    });
  } catch (e) {
    console.error('[Controller] Initialize error:', e.message);
    next(e);
  }
};

/**
 * GET /api/subscriptions/verify/:txRef
 * Verify payment status using transaction reference
 * No auth required — tx_ref is the proof
 */
export const verify = async (req, res, next) => {
  try {
    const { txRef } = req.params;
    
    if (!txRef) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Transaction reference is required',
      });
    }

    console.log('[Controller] Verifying payment:', txRef);
    const data = await svc.verifyPayment(txRef);
    
    res.status(200).json({
      success: true,
      ...data,
    });
  } catch (e) {
    console.error('[Controller] Verify error:', e.message);
    next(e);
  }
};

/**
 * GET /api/subscriptions/status
 * Get subscription status for current user
 * Requires: Auth token
 */
export const getStatus = async (req, res, next) => {
  try {
    const ownerId = getUserId(req);
    if (!ownerId) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Authentication required',
      });
    }

    console.log('[Controller] Fetching status for owner:', ownerId);
    const data = await svc.getSubscriptionStatus(ownerId);
    
    res.status(200).json({
      success: true,
      ...data,
    });
  } catch (e) {
    console.error('[Controller] Status error:', e.message);
    next(e);
  }
};

/**
 * GET /api/webhooks/chapa
 * Webhook callback from Chapa payment gateway
 * 
 * Chapa redirects here with query params:
 * - tx_ref: transaction reference
 * - status: 'success', 'failed', 'cancelled', etc.
 * 
 * This endpoint should NOT require authentication
 */
export const chapaWebhook = async (req, res, next) => {
  try {
    // Extract query parameters from Chapa
    const { tx_ref: txRef, status } = req.query;

    console.log('[Webhook] Received Chapa callback');
    console.log('[Webhook] Query params:', { txRef, status });

    // Validate required parameters
    if (!txRef || !status) {
      console.error('[Webhook] Missing required parameters');
      return res.status(400).json({
        error: 'Bad Request',
        message: 'tx_ref and status are required',
      });
    }

    // Process the webhook
    const result = await svc.handleChapaWebhook(txRef, status);

    // Always return 200 to acknowledge receipt (don't retry)
    res.status(200).json({
      success: true,
      ...result,
    });
  } catch (e) {
    console.error('[Webhook] Error processing callback:', e.message);
    // Still return 200 to acknowledge (don't retry)
    res.status(200).json({
      error: e.message,
      message: 'Webhook processed with error',
    });
  }
};