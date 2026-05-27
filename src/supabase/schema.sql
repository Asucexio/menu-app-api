-- ============================================================
--  QR Menu Builder — Database Schema
--  Auth: Supabase Auth (auth.users built-in)
--  Run this entire file in Supabase SQL Editor
-- ============================================================

create extension if not exists "uuid-ossp";

-- ============================================================
--  PROFILES
--  mirrors auth.users — one row per registered owner
-- ============================================================
create table if not exists profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text not null,
  full_name   text,
  avatar_url  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ============================================================
--  RESTAURANTS
-- ============================================================
create table if not exists restaurants (
  id          uuid primary key default uuid_generate_v4(),
  owner_id    uuid not null references profiles(id) on delete cascade,
  name        text not null,
  slug        text not null unique,
  description text,
  logo_url    text,
  address     text,
  phone       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ============================================================
--  MENUS
-- ============================================================
create table if not exists menus (
  id            uuid primary key default uuid_generate_v4(),
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  name          text not null default 'Main Menu',
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ============================================================
--  CATEGORIES
-- ============================================================
create table if not exists categories (
  id         uuid primary key default uuid_generate_v4(),
  menu_id    uuid not null references menus(id) on delete cascade,
  name       text not null,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

-- ============================================================
--  ITEMS
-- ============================================================
create table if not exists items (
  id           uuid primary key default uuid_generate_v4(),
  category_id  uuid not null references categories(id) on delete cascade,
  name         text not null,
  description  text,
  price        numeric(10,2) not null check (price >= 0),
  image_url    text,
  is_available boolean not null default true,
  sort_order   int not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ============================================================
--  QR CODES
-- ============================================================
create table if not exists qr_codes (
  id         uuid primary key default uuid_generate_v4(),
  menu_id    uuid not null references menus(id) on delete cascade,
  public_url text not null,
  image_path text,
  created_at timestamptz not null default now()
);

-- ============================================================
--  SUBSCRIPTIONS
-- ============================================================
create table if not exists subscriptions (
  id            uuid primary key default uuid_generate_v4(),
  owner_id      uuid not null references profiles(id) on delete cascade,
  plan          text not null default 'free'
                  check (plan in ('free','basic','pro')),
  status        text not null default 'inactive'
                  check (status in ('pending','active','inactive','expired','cancelled')),
  chapa_tx_ref  text unique,
  started_at    timestamptz,
  expires_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ============================================================
--  AUTO updated_at TRIGGER
-- ============================================================
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger profiles_updated_at
  before update on profiles for each row execute function update_updated_at();
create trigger restaurants_updated_at
  before update on restaurants for each row execute function update_updated_at();
create trigger menus_updated_at
  before update on menus for each row execute function update_updated_at();
create trigger items_updated_at
  before update on items for each row execute function update_updated_at();
create trigger subscriptions_updated_at
  before update on subscriptions for each row execute function update_updated_at();

-- ============================================================
--  INDEXES
-- ============================================================
create index if not exists idx_restaurants_owner_id    on restaurants(owner_id);
create index if not exists idx_menus_restaurant_id     on menus(restaurant_id);
create index if not exists idx_categories_menu_id      on categories(menu_id);
create index if not exists idx_items_category_id       on items(category_id);
create index if not exists idx_qr_codes_menu_id        on qr_codes(menu_id);
create index if not exists idx_subscriptions_owner_id  on subscriptions(owner_id);
create index if not exists idx_subscriptions_tx_ref    on subscriptions(chapa_tx_ref);

-- ============================================================
--  ROW LEVEL SECURITY
-- ============================================================
alter table profiles       enable row level security;
alter table restaurants    enable row level security;
alter table menus          enable row level security;
alter table categories     enable row level security;
alter table items          enable row level security;
alter table qr_codes       enable row level security;
alter table subscriptions  enable row level security;

-- PROFILES
create policy "owners can view own profile"
  on profiles for select using (auth.uid() = id);
create policy "owners can update own profile"
  on profiles for update using (auth.uid() = id);

-- RESTAURANTS
create policy "owners can manage own restaurants"
  on restaurants for all using (auth.uid() = owner_id);
create policy "public can view restaurants"
  on restaurants for select using (true);

-- MENUS
create policy "owners can manage own menus"
  on menus for all using (
    auth.uid() = (select owner_id from restaurants where id = restaurant_id)
  );
create policy "public can view active menus"
  on menus for select using (is_active = true);

-- CATEGORIES
create policy "owners can manage own categories"
  on categories for all using (
    auth.uid() = (
      select r.owner_id from restaurants r
      join menus m on m.restaurant_id = r.id
      where m.id = menu_id
    )
  );
create policy "public can view categories"
  on categories for select using (true);

-- ITEMS
create policy "owners can manage own items"
  on items for all using (
    auth.uid() = (
      select r.owner_id from restaurants r
      join menus m on m.restaurant_id = r.id
      join categories c on c.menu_id = m.id
      where c.id = category_id
    )
  );
create policy "public can view available items"
  on items for select using (is_available = true);

-- QR CODES
create policy "owners can manage own qr codes"
  on qr_codes for all using (
    auth.uid() = (
      select r.owner_id from restaurants r
      join menus m on m.restaurant_id = r.id
      where m.id = menu_id
    )
  );
create policy "public can view qr codes"
  on qr_codes for select using (true);

-- SUBSCRIPTIONS
create policy "owners can view own subscription"
  on subscriptions for select using (auth.uid() = owner_id);

-- ============================================================
--  AUTO-CREATE PROFILE ON SIGNUP
--  Fires whenever a new user registers via Supabase Auth
-- ============================================================
create or replace function handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email, full_name, avatar_url)
  values (
    new.id,
    new.email,
    new.raw_user_meta_data->>'full_name',
    new.raw_user_meta_data->>'avatar_url'
  );
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ============================================================
--  VERIFY (uncomment and run after migration)
-- ============================================================
-- select table_name from information_schema.tables
-- where table_schema = 'public' order by table_name;
