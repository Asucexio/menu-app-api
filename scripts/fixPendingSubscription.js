import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const arg = process.argv[2];
const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

let query = supabase
  .from('subscriptions')
  .update({ status: 'active', started_at: new Date().toISOString(), expires_at: expiresAt })
  .eq('status', 'pending');

if (arg && arg !== '--all') query = query.eq('chapa_tx_ref', arg);

const { data, error } = await query.select();

if (error) {
  console.error('Error:', error.message);
} else if (!data?.length) {
  console.log('No pending subscriptions found.');
} else {
  console.log(`Activated ${data.length} subscription(s):`);
  data.forEach(s => console.log(`  ${s.id} | ${s.plan} | expires ${s.expires_at}`));
}
