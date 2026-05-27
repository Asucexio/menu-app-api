import supabase from '../lib/supabaseclient.js';

const assertRestaurantOwner = async (ownerId, restaurantId) => {
  const { data } = await supabase
    .from('restaurants').select('id').eq('id', restaurantId).eq('owner_id', ownerId).single();
  if (!data) throw Object.assign(new Error('Restaurant not found or access denied'), { status: 403 });
};

const assertMenuOwner = async (ownerId, menuId) => {
  const { data } = await supabase
    .from('menus')
    .select('id, restaurants!inner(owner_id)')
    .eq('id', menuId)
    .eq('restaurants.owner_id', ownerId)
    .single();
  if (!data) throw Object.assign(new Error('Menu not found or access denied'), { status: 403 });
  return data;
};

export const createMenu = async (ownerId, body) => {
  const { restaurant_id, name } = body;
  if (!restaurant_id) throw Object.assign(new Error('restaurant_id is required'), { status: 400 });
  await assertRestaurantOwner(ownerId, restaurant_id);


  // ── Check subscription menu limit ──────────────────────────
  const { data: sub } = await supabase
    .from('subscriptions')
    .select('plan, status, expires_at')
    .eq('owner_id', ownerId)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  const LIMITS = { basic: 1, pro: 3 , free: 0};
  const limit = LIMITS[sub?.plan] ?? 0;

  const { count } = await supabase
    .from('menus')
    .select('id', { count: 'exact', head: true })
    .eq('restaurant_id', restaurant_id);

  if ((count ?? 0) >= limit) {
    throw Object.assign(
      new Error(
        sub?.plan === 'basic'
          ? `Basic plan allows up to ${limit} menus. Upgrade to Pro for unlimited menus.`
          : `Upgrade to a paid plan to create menus.`
      ),
      { status: 403 }
    );
  }
  // ──────────────────────────────────────────────────────────

  const { data, error } = await supabase
    .from('menus').insert({ restaurant_id, name: name || 'Main Menu' }).select().single();
  if (error) throw error;
  return data;
};

export const getMenusByRestaurant = async (ownerId, restaurantId) => {
  await assertRestaurantOwner(ownerId, restaurantId);
  const { data, error } = await supabase
    .from('menus').select('*').eq('restaurant_id', restaurantId).order('created_at');
  if (error) throw error;
  return data;
};

export const getMenuById = async (menuId) => {
  const { data, error } = await supabase
    .from('menus')
    .select(`*, categories(id, name, sort_order,
      items(id, name, description, price, image_url, is_available, sort_order))`)
    .eq('id', menuId).single();
  if (error) throw Object.assign(new Error('Menu not found'), { status: 404 });
  data.categories?.sort((a, b) => a.sort_order - b.sort_order);
  data.categories?.forEach(c => c.items?.sort((a, b) => a.sort_order - b.sort_order));
  return data;
};

export const getPublicMenu = async (menuId) => {
  const { data, error } = await supabase
    .from('menus')
    .select(`id, name,
      restaurants(name, logo_url, address, phone),
      categories(id, name, sort_order,
        items(id, name, description, price, image_url, is_available, sort_order))`)
    .eq('id', menuId).eq('is_active', true).single();
  if (error) throw Object.assign(new Error('Menu not found'), { status: 404 });
  data.categories?.sort((a, b) => a.sort_order - b.sort_order);
  data.categories?.forEach(c => {
    c.items = c.items?.filter(i => i.is_available).sort((a, b) => a.sort_order - b.sort_order);
  });
  return data;
};

export const updateMenu = async (ownerId, menuId, body) => {
  await assertMenuOwner(ownerId, menuId);
  const allowed = ['name', 'is_active'];
  const updates = Object.fromEntries(Object.entries(body).filter(([k]) => allowed.includes(k)));
  const { data, error } = await supabase
    .from('menus').update(updates).eq('id', menuId).select().single();
  if (error) throw error;
  return data;
};

export const deleteMenu = async (ownerId, menuId) => {
  await assertMenuOwner(ownerId, menuId);
  const { error } = await supabase.from('menus').delete().eq('id', menuId);
  if (error) throw error;
};
