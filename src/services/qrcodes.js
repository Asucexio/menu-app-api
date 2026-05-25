 import QRCode from 'qrcode';
import supabase from '../lib/supabaseclient.js';

const assertMenuOwner = async (ownerId, menuId) => {
  const { data } = await supabase
    .from('menus')
    .select('id, restaurants!inner(owner_id)')
    .eq('id', menuId)
    .eq('restaurants.owner_id', ownerId)
    .single();
  if (!data) throw Object.assign(new Error('Menu not found or access denied'), { status: 403 });
};

export const generateQRCode = async (ownerId, menuId) => {
  await assertMenuOwner(ownerId, menuId);

  const publicUrl = `${process.env.CLIENT_URL}/menu/${menuId}`;

  const buffer = await QRCode.toBuffer(publicUrl, {
    type: 'png',
    width: 500,
    margin: 2,
    errorCorrectionLevel: 'H',
    color: { dark: '#000000', light: '#FFFFFF' },
  });

  const storagePath = `qr-codes/${menuId}.png`;
  let imageUrl = `${process.env.API_URL || ''}/api/qr/${menuId}/download`;

  const { error: uploadErr } = await supabase.storage
    .from('menu-assets')
    .upload(storagePath, buffer, { contentType: 'image/png', upsert: true });

  if (uploadErr) {
    const isRlsError = uploadErr.statusCode === '403' || /row-level security policy/i.test(uploadErr.message || '');
    if (!isRlsError) throw uploadErr;
    console.warn('[QR] Storage upload blocked by RLS; falling back to download endpoint URL.');
  } else {
    const { data } = supabase.storage
      .from('menu-assets').getPublicUrl(storagePath);
    imageUrl = data?.publicUrl || imageUrl;
  }

  const { data, error } = await supabase
    .from('qr_codes')
    .upsert({ menu_id: menuId, public_url: publicUrl, image_path: imageUrl },
             { onConflict: 'menu_id' })
    .select().single();
  if (error) throw error;

  return data;
};

export const getQRByMenu = async (ownerId, menuId) => {
  await assertMenuOwner(ownerId, menuId);
  const { data, error } = await supabase
    .from('qr_codes').select('*').eq('menu_id', menuId).single();
  if (error) throw Object.assign(new Error('QR code not generated yet'), { status: 404 });
  return data;
};

export const downloadQRBuffer = async (ownerId, menuId) => {
  await assertMenuOwner(ownerId, menuId);
  const publicUrl = `${process.env.CLIENT_URL}/menu/${menuId}`;
  return QRCode.toBuffer(publicUrl, { type: 'png', width: 800, margin: 2, errorCorrectionLevel: 'H' });
};