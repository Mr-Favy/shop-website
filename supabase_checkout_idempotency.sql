-- Additive migration for retry-safe checkout. Run after supabase_schema.sql.
begin;

alter table public.orders
  add column if not exists checkout_key uuid,
  add column if not exists checkout_payload_hash text;

create unique index if not exists orders_user_checkout_key_uq
  on public.orders (user_id, checkout_key)
  where checkout_key is not null;

create or replace function public.create_order_idempotent(
  p_user_id uuid,
  p_name text,
  p_email text,
  p_address text,
  p_items jsonb,
  p_checkout_key uuid,
  p_checkout_payload_hash text
)
returns table(id bigint, total_minor bigint, created boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item jsonb;
  v_product public.products%rowtype;
  v_qty integer;
  v_total bigint := 0;
  v_order_id bigint;
  v_existing_total bigint;
  v_existing_hash text;
begin
  if p_user_id is null or p_checkout_key is null or p_checkout_payload_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid checkout key';
  end if;

  -- Serialize concurrent retries for the same user/key before checking or inserting.
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || p_checkout_key::text, 0));
  select orders.id, orders.total_minor, orders.checkout_payload_hash
    into v_order_id, v_existing_total, v_existing_hash
    from public.orders
    where orders.user_id = p_user_id and orders.checkout_key = p_checkout_key;
  if found then
    if v_existing_hash is distinct from p_checkout_payload_hash then
      raise exception 'Checkout idempotency key was reused with different order details';
    end if;
    return query select v_order_id, v_existing_total, false;
    return;
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Basket is empty';
  end if;
  if length(trim(p_address)) = 0 or length(p_address) > 500 then raise exception 'Invalid delivery address'; end if;

  insert into public.users (id, name, email) values (p_user_id, trim(p_name), lower(trim(p_email)))
    on conflict (id) do update set name = excluded.name, email = excluded.email;
  for v_item in select value from jsonb_array_elements(p_items) loop
    v_qty := (v_item->>'qty')::integer;
    if v_qty < 1 or v_qty > 100 then raise exception 'Invalid quantity'; end if;
    select * into v_product from public.products where products.id = (v_item->>'id')::bigint and active = true;
    if not found then raise exception 'Product is unavailable'; end if;
    v_total := v_total + v_product.price_minor::bigint * v_qty;
    insert into public.cart_items (user_id, product_id, quantity) values (p_user_id, v_product.id, v_qty)
      on conflict (user_id, product_id) do update set quantity = excluded.quantity, updated_at = now();
  end loop;

  insert into public.orders (user_id, customer_email, total_minor, shipping_address, checkout_key, checkout_payload_hash)
    values (p_user_id, lower(trim(p_email)), v_total, trim(p_address), p_checkout_key, p_checkout_payload_hash)
    returning orders.id into v_order_id;
  for v_item in select value from jsonb_array_elements(p_items) loop
    v_qty := (v_item->>'qty')::integer;
    select * into v_product from public.products where products.id = (v_item->>'id')::bigint and active = true;
    insert into public.order_items (order_id, product_id, product_name, unit_price_minor, quantity)
      values (v_order_id, v_product.id, v_product.name, v_product.price_minor, v_qty);
    delete from public.cart_items where user_id = p_user_id and product_id = v_product.id;
  end loop;
  return query select v_order_id, v_total, true;
end;
$$;

revoke all on function public.create_order_idempotent(uuid, text, text, text, jsonb, uuid, text) from public, anon, authenticated;
grant execute on function public.create_order_idempotent(uuid, text, text, text, jsonb, uuid, text) to service_role;

commit;
