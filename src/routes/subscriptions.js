import { Router } from 'express';
import { protect } from '../middlewares/auth.js';
import * as ctrl from '../controllers/subscriptions.js';

const r = Router();

// ── Public — tx_ref is the proof of payment, no token needed ─
r.get('/verify/:txRef', ctrl.verify);

// ── Protected ────────────────────────────────────────────────
r.post('/initialize', protect, ctrl.initialize);
r.get('/status'      , ctrl.getStatus);

export default r;
