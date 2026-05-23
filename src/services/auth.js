import { supabaseAdmin } from '../lib/supabaseClient.js';

// ── Sign Up ──────────────────────────────────────────────────
export const signUp = async ({ email, password, full_name }) => {
  if (!email || !password || !full_name)
    throw Object.assign(
      new Error('email, password and full_name are required'),
      { status: 400 }
    );

  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name },
  });

  if (error) throw Object.assign(new Error(error.message), { status: 400 });

  // manually create profile row in case trigger didn't fire
  await supabaseAdmin.from('profiles').upsert({
    id: data.user.id,
    email: data.user.email,
    full_name,
  }, { onConflict: 'id' });

  return {
    message: 'Account created successfully',
    user: { id: data.user.id, email: data.user.email, full_name },
  };
};

// ── Sign In ──────────────────────────────────────────────────
export const signIn = async ({ email, password }) => {
  if (!email || !password)
    throw Object.assign(
      new Error('email and password are required'),
      { status: 400 }
    );

  const { data, error } = await supabaseAdmin.auth.signInWithPassword({
    email,
    password,
  });

  if (error) throw Object.assign(new Error(error.message), { status: 401 });

  const full_name = data.user.user_metadata?.full_name || '';

  return {
    access_token:  data.session.access_token,
    refresh_token: data.session.refresh_token,
    expires_in:    data.session.expires_in,
    user: {
      id:        data.user.id,
      email:     data.user.email,
      full_name,
    },
  };
};

// ── Refresh Token ────────────────────────────────────────────
export const refreshToken = async (refresh_token) => {
  if (!refresh_token)
    throw Object.assign(new Error('refresh_token is required'), { status: 400 });

  const { data, error } = await supabaseAdmin.auth.refreshSession({
    refresh_token,
  });

  if (error) throw Object.assign(new Error(error.message), { status: 401 });

  return {
    access_token:  data.session.access_token,
    refresh_token: data.session.refresh_token,
    expires_in:    data.session.expires_in,
  };
};

// ── Get Profile ──────────────────────────────────────────────
export const getProfile = async (userId) => {
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single();

  if (error || !data) {
    // profile row might not exist yet — create it
    const { data: userData } = await supabaseAdmin.auth.admin.getUserById(userId);
    if (!userData?.user) throw Object.assign(new Error('User not found'), { status: 404 });

    const newProfile = {
      id: userId,
      email: userData.user.email,
      full_name: userData.user.user_metadata?.full_name || '',
    };
    await supabaseAdmin.from('profiles').upsert(newProfile, { onConflict: 'id' });
    return newProfile;
  }

  return data;
};

// ── Update Profile ───────────────────────────────────────────
export const updateProfile = async (userId, body) => {
  const allowed = ['full_name', 'avatar_url'];
  const updates = Object.fromEntries(
    Object.entries(body).filter(([k]) => allowed.includes(k))
  );

  const { data, error } = await supabaseAdmin
    .from('profiles')
    .update(updates)
    .eq('id', userId)
    .select()
    .single();

  if (error) throw error;
  return data;
};

// ── Change Password ──────────────────────────────────────────
export const changePassword = async (userId, newPassword) => {
  if (!newPassword || newPassword.length < 6)
    throw Object.assign(
      new Error('Password must be at least 6 characters'),
      { status: 400 }
    );

  const { error } = await supabaseAdmin.auth.admin.updateUserById(userId, {
    password: newPassword,
  });

  if (error) throw Object.assign(new Error(error.message), { status: 400 });
  return { message: 'Password updated successfully' };
};
