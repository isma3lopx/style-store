// ============================================
// supabase-config.js
// ضع مفاتيحك هنا من لوحة تحكم Supabase + EmailJS
// ============================================

// ===== Supabase (https://supabase.com) =====
const SUPABASE_URL = 'https://mtilpmmrdjzvsiotgzcn.supabase.co';       // ← Project URL
const SUPABASE_ANON_KEY = 'sb_publishable_BlrqDRwzz6QisGFFuP7Sjw_n2snghrT';              // ← anon public key

// ===== EmailJS (https://emailjs.com) =====
const EMAILJS_PUBLIC_KEY = '4jjQHkJzgxEUxvUc8';          // ← Public Key
const EMAILJS_SERVICE_ID = 'service_abc123';            // ← Service ID
const EMAILJS_TEMPLATES = {
  welcome: 'template_dkkihb9',   // رسالة الترحيب
  order:   'template_09rucue',     // تأكيد الطلب
  reset:   'template_reset'      // استعادة كلمة المرور
};

// ===== Initialize =====
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
emailjs.init(EMAILJS_PUBLIC_KEY);

// ============================================
// Helper: إرسال إيميل
// ============================================
async function sendEmail(templateId, params) {
  try {
    const res = await emailjs.send(EMAILJS_SERVICE_ID, templateId, params);
    console.log('✅ Email sent:', res.status);
    return { ok: true };
  } catch (err) {
    console.error('❌ Email error:', err);
    return { ok: false, error: err.text || err.message };
  }
}

// ============================================
// Auth Helper
// ============================================
const auth = {
  async register({ name, email, password, phone }) {
    const { data, error } = await supabaseClient.auth.signUp({
      email, password,
      options: { data: { name, phone } }
    });
    if (error) throw error;
    if (data.user) {
      sendEmail(EMAILJS_TEMPLATES.welcome, { to_email: email, to_name: name });
    }
    return data;
  },

  async login({ email, password }) {
    const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data;
  },

  async logout() {
    await supabaseClient.auth.signOut();
  },

  async getUser() {
    const { data } = await supabaseClient.auth.getUser();
    return data.user;
  },

  async getProfile() {
    const user = await this.getUser();
    if (!user) return null;
    const { data } = await supabaseClient
      .from('profiles').select('*').eq('id', user.id).single();
    return data || { id: user.id, name: user.email.split('@')[0], email: user.email, role: 'customer' };
  },

  async updateProfile(updates) {
    const user = await this.getUser();
    if (!user) throw new Error('Not logged in');
    const { error } = await supabaseClient
      .from('profiles').update(updates).eq('id', user.id);
    if (error) throw error;
  },

  async resetPassword(email) {
    const { error } = await supabaseClient.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin + '/update-password.html'
    });
    if (error) throw error;
    return true;
  }
};

// ============================================
// Database Helper
// ============================================
const db = {
  // ---------- Products ----------
  async getProducts(filters = {}) {
    let q = supabaseClient.from('products').select('*').eq('active', true);
    if (filters.category) q = q.eq('category', filters.category);
    if (filters.search) q = q.or(`name.ilike.%${filters.search}%,description.ilike.%${filters.search}%`);
    if (filters.sort === 'price_asc') q = q.order('price', { ascending: true });
    else if (filters.sort === 'price_desc') q = q.order('price', { ascending: false });
    else q = q.order('created_at', { ascending: false });
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  },

  async getProduct(id) {
    const { data, error } = await supabaseClient
      .from('products').select('*').eq('id', id).single();
    if (error) throw error;
    return data;
  },

  // ---------- Orders ----------
  async createOrder({ items, shipping, notes, paymentMethod }) {
    const user = await auth.getUser();
    if (!user) throw new Error('يجب تسجيل الدخول أولاً');

    // جلب أسعار المنتجات الحقيقية
    const ids = items.map(i => i.id);
    const { data: prods, error: pErr } = await supabaseClient
      .from('products').select('*').in('id', ids);
    if (pErr) throw pErr;
    if (!prods || prods.length !== items.length) throw new Error('بعض المنتجات غير متاحة');

    let total = 0;
    for (const it of items) {
      const p = prods.find(x => x.id === it.id);
      if (!p || p.stock < it.qty) {
        throw new Error('الكمية غير كافية: ' + (p?.name || ''));
      }
      total += p.price * it.qty;
    }

    const orderNumber = 'STY-' + Date.now();

    const { data: order, error: oErr } = await supabaseClient
      .from('orders')
      .insert({
        user_id: user.id,
        order_number: orderNumber,
        total,
        payment_method: paymentMethod,
        shipping_name: shipping.name,
        shipping_phone: shipping.phone,
        shipping_address: shipping.address,
        shipping_city: shipping.city,
        notes
      })
      .select()
      .single();
    if (oErr) throw oErr;

    // إدراج عناصر الطلب
    const orderItems = items.map(it => {
      const p = prods.find(x => x.id === it.id);
      return {
        order_id: order.id,
        product_id: p.id,
        product_name: p.name,
        product_image: p.image,
        size: it.size,
        price: p.price,
        qty: it.qty
      };
    });
    const { error: iErr } = await supabaseClient
      .from('order_items').insert(orderItems);
    if (iErr) throw iErr;

    // خصم المخزون
    for (const it of items) {
      const p = prods.find(x => x.id === it.id);
      await supabaseClient
        .from('products')
        .update({ stock: p.stock - it.qty })
        .eq('id', p.id);
    }

    // إرسال إيميل تأكيد الطلب
    sendEmail(EMAILJS_TEMPLATES.order, {
      to_email: user.email,
      to_name: shipping.name,
      order_number: orderNumber,
      order_total: total + ' EGP'
    });

    return { order, orderNumber };
  },

  async getMyOrders() {
    const user = await auth.getUser();
    if (!user) return [];
    const { data, error } = await supabaseClient
      .from('orders')
      .select('*, order_items(*)')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });
    if (error) return [];
    return data || [];
  },

  // ---------- Wishlist ----------
  async getWishlist() {
    const user = await auth.getUser();
    if (!user) return [];
    const { data } = await supabaseClient
      .from('wishlists')
      .select('product_id')
      .eq('user_id', user.id);
    return (data || []).map(x => x.product_id);
  },

  async toggleWishlist(productId) {
    const user = await auth.getUser();
    if (!user) throw new Error('سجّل دخول أولاً');

    const { data: existing } = await supabaseClient
      .from('wishlists')
      .select('id')
      .eq('user_id', user.id)
      .eq('product_id', productId)
      .maybeSingle();

    if (existing) {
      await supabaseClient.from('wishlists').delete().eq('id', existing.id);
      return false;
    } else {
      await supabaseClient
        .from('wishlists')
        .insert({ user_id: user.id, product_id: productId });
      return true;
    }
  }
};