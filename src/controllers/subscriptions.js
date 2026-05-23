import * as svc from '../services/subscriptions.js';
import { getUserId } from '../middlewares/auth.js';

export const initialize = async (req, res, next) => {
  try {
    const data = await svc.initializePayment(getUserId(req), req.body);
    res.json(data);
  } catch (e) { next(e); }
};

// No auth — tx_ref is the proof
export const verify = async (req, res, next) => {
  try {
    const data = await svc.verifyPayment(req.params.txRef);
    res.json(data);
  } catch (e) { next(e); }
};

export const getStatus = async (req, res, next) => {
  try {
    const data = await svc.getSubscriptionStatus(getUserId(req));
    res.json(data);
  } catch (e) { next(e); }
};
