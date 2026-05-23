import { supabaseClient } from '../lib/supabaseClient.js';  // ✅ Correct

// ── protect ──────────────────────────────────────────────────
export const protect = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid Authorization header' });
    }

    const token = authHeader.split(' ')[1];
    if (!token || token === 'null' || token === 'undefined') {
      return res.status(401).json({ error: 'Invalid token value' });
    }

    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);

    if (error || !user) {
      console.warn('[Auth] Token validation failed:', error?.message);
      return res.status(401).json({ error: 'Invalid or expired token. Please sign in again.' });
    }

    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
};

// ── getUserId ────────────────────────────────────────────────
export const getUserId = (req) => {
  if (!req.user?.id) throw Object.assign(new Error('Unauthorized'), { status: 401 });
  return req.user.id;
};
