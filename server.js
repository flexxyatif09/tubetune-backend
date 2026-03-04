const fetch = require('node-fetch');
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

// ── Normal client (anon key) — public operations ke liye ──
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ── Admin client (service_role key) — RLS bypass, admin operations ke liye ──
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY
);

const razorpay = new Razorpay({
  key_id:     process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

// ── ADMIN AUTH ──
function auth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ── HELPER: Supabase JWT se user nikalo ──
async function getUserFromToken(token) {
  if (!token) return null;
  try {
    const r = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
      headers: {
        apikey: process.env.SUPABASE_KEY,
        Authorization: 'Bearer ' + token
      }
    });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// ── MIDDLEWARE: Premium check ──
async function premiumAuth(req, res, next) {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    const user = await getUserFromToken(token);
    if (!user?.id) {
      return res.status(401).json({ success: false, error: 'Login zaroori hai' });
    }

    // supabaseAdmin use karo — RLS bypass hoga
    const { data: sub, error: subError } = await supabaseAdmin
      .from('subscriptions')
      .select('id, expires_at, status')
      .eq('user_id', user.id)
      .limit(1)
      .maybeSingle();

    if (subError) console.error('premiumAuth DB error:', subError.message);

    if (!sub) {
      return res.status(403).json({
        success: false,
        error: 'Premium subscription chahiye',
        code: 'NOT_PREMIUM'
      });
    }

    // Agar expires_at column hai toh expiry check karo, warna sirf existence kaafi hai
    if (sub.expires_at && new Date(sub.expires_at) < new Date()) {
      return res.status(403).json({
        success: false,
        error: 'Premium subscription expire ho gaya',
        code: 'PREMIUM_EXPIRED'
      });
    }

    req.userId = user.id;
    next();
  } catch (err) {
    console.error('premiumAuth error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
}

// ── GET ALL SONGS ──
app.get('/api/songs', async (req, res) => {
  try {
    const { search, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    let query = supabase
      .from('songs')
      .select('*')
      .order('created_at', { ascending: false })
      .range(offset, offset + Number(limit) - 1);
    if (search) {
      query = query.or(`title.ilike.%${search}%,artist.ilike.%${search}%`);
    }
    const { data, error } = await query;
    if (error) throw error;
    res.json({ success: true, total: data.length, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET SINGLE SONG ──
app.get('/api/songs/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('songs')
      .select('*')
      .eq('id', req.params.id)
      .single();
    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    res.status(404).json({ error: 'Song not found' });
  }
});

// ── UPLOAD SONG (admin) ──
app.post('/api/upload', auth, async (req, res) => {
  try {
    const { url, quality = '320' } = req.body;

    if (!url || (!url.includes('youtube.com') && !url.includes('youtu.be'))) {
      return res.status(400).json({ error: 'Invalid YouTube URL' });
    }

    let videoId = '';
    if (url.includes('watch?v=')) {
      videoId = url.split('watch?v=')[1].split('&')[0];
    } else if (url.includes('youtu.be/')) {
      videoId = url.split('youtu.be/')[1].split('?')[0];
    }
    if (!videoId) return res.status(400).json({ error: 'Invalid URL' });

    let title = 'Unknown Title';
    let artist = 'Unknown Artist';
    let duration = '0:00';
    const thumbnail = `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;

    try {
      const oRes = await fetch(
        `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`
      );
      if (oRes.ok) {
        const oData = await oRes.json();
        title  = oData.title       || title;
        artist = oData.author_name || artist;
      }
    } catch(e) { console.log('oembed:', e.message); }

    const rapidRes = await fetch(
      `https://youtube-mp36.p.rapidapi.com/dl?id=${videoId}`,
      {
        method: 'GET',
        headers: {
          'X-RapidAPI-Key':  process.env.RAPIDAPI_KEY,
          'X-RapidAPI-Host': 'youtube-mp36.p.rapidapi.com'
        }
      }
    );
    const rapidData = await rapidRes.json();
    console.log('RapidAPI response:', rapidData);

    if (rapidData.status !== 'ok' || !rapidData.link) {
      throw new Error('MP3 link nahi mila: ' + (rapidData.msg || JSON.stringify(rapidData)));
    }

    const mp3Url = rapidData.link;
    duration = rapidData.duration
      ? `${Math.floor(rapidData.duration/60)}:${String(rapidData.duration%60).padStart(2,'0')}`
      : '0:00';

    const audioRes = await fetch(mp3Url);
    if (!audioRes.ok) throw new Error('Audio download failed');
    const audioBuffer = Buffer.from(await audioRes.arrayBuffer());

    const fileName = `${Date.now()}_${videoId}.mp3`;
    const { error: uploadError } = await supabase.storage
      .from('audio')
      .upload(fileName, audioBuffer, { contentType: 'audio/mpeg', upsert: false });
    if (uploadError) throw uploadError;

    const { data: { publicUrl: audioUrl } } = supabase.storage
      .from('audio')
      .getPublicUrl(fileName);

    const { data: song, error: dbError } = await supabaseAdmin
      .from('songs')
      .insert({
        title, artist, thumbnail,
        audio_url: audioUrl,
        duration,
        quality: quality + 'kbps',
        youtube_url: url
      })
      .select()
      .single();
    if (dbError) throw dbError;

    res.json({
      success: true,
      song: {
        id: song.id, title: song.title, artist: song.artist,
        thumbnail: song.thumbnail, audioUrl: song.audio_url,
        duration: song.duration, quality: song.quality
      }
    });
  } catch (err) {
    console.error('Upload error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── CONFIG (Razorpay key frontend ko dena) ──
app.get('/api/config', (req, res) => {
  res.json({ razorpay_key_id: process.env.RAZORPAY_KEY_ID || '' });
});

// ── GET PLANS (public — only active) ──
app.get('/api/plans', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('plans')
      .select('*')
      .eq('is_active', true)
      .order('price', { ascending: true });
    if (error) throw error;
    res.json({ success: true, plans: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET ALL PLANS including disabled (admin) ──
app.get('/api/plans/all', auth, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('plans')
      .select('*')
      .order('price', { ascending: true });
    if (error) throw error;
    res.json({ success: true, plans: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── ADD PLAN (admin) ──
app.post('/api/plans', auth, async (req, res) => {
  try {
    const { name, description, price, duration_days, features, is_active } = req.body;
    if (!name || !price || !duration_days) {
      return res.status(400).json({ success: false, error: 'name, price aur duration_days required hai' });
    }
    const { data, error } = await supabaseAdmin
      .from('plans')
      .insert({
        name,
        description:   description   || '',
        price:         Number(price),
        duration_days: Number(duration_days),
        features:      features      || [],
        is_active:     is_active !== undefined ? is_active : true
      })
      .select()
      .single();
    if (error) throw error;
    res.json({ success: true, plan: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── UPDATE PLAN (admin) ──
app.put('/api/plans/:id', auth, async (req, res) => {
  try {
    const { name, description, price, duration_days, features, is_active } = req.body;
    const updates = {};
    if (name          !== undefined) updates.name          = name;
    if (description   !== undefined) updates.description   = description;
    if (price         !== undefined) updates.price         = Number(price);
    if (duration_days !== undefined) updates.duration_days = Number(duration_days);
    if (features      !== undefined) updates.features      = features;
    if (is_active     !== undefined) updates.is_active     = is_active;

    const { data, error } = await supabaseAdmin
      .from('plans')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw error;
    res.json({ success: true, plan: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── DELETE PLAN (admin) ──
app.delete('/api/plans/:id', auth, async (req, res) => {
  try {
    const { error } = await supabaseAdmin
      .from('plans')
      .delete()
      .eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET ALL SUBSCRIPTIONS (admin) ──
app.get('/api/subscriptions/all', auth, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('subscriptions')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET ALL USERS (admin) ──
app.get('/api/users/all', auth, async (req, res) => {
  try {
    // Supabase Admin API se saare users lo
    const r = await fetch(`${process.env.SUPABASE_URL}/auth/v1/admin/users?per_page=500`, {
      headers: {
        apikey:        process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY,
        Authorization: 'Bearer ' + (process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY)
      }
    });
    if (!r.ok) throw new Error('Auth API error: ' + r.status);
    const authData = await r.json();
    const authUsers = authData.users || [];

    // Active subscriptions bhi lo (sirf jinke paas row hai)
    const { data: subs } = await supabaseAdmin
      .from('subscriptions')
      .select('*');

    const subsMap = {};
    (subs || []).forEach(s => { subsMap[s.user_id] = s; });

    const users = authUsers.map(u => ({
      id:          u.id,
      email:       u.email || '',
      created_at:  u.created_at,
      last_sign_in: u.last_sign_in_at || null,
      isPremium:   !!subsMap[u.id],
      subscription: subsMap[u.id] || null
    }));

    res.json({ success: true, users });
  } catch (err) {
    console.error('Users fetch error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GRANT PREMIUM MANUALLY (admin) ──
app.post('/api/admin/grant-premium', auth, async (req, res) => {
  try {
    const { user_id, plan_id, duration_days } = req.body;
    if (!user_id) return res.status(400).json({ success: false, error: 'user_id required' });

    let planName = 'Admin Grant';
    let planPrice = 0;
    let days = duration_days || 30;

    if (plan_id) {
      const { data: plan } = await supabaseAdmin
        .from('plans').select('*').eq('id', plan_id).single();
      if (plan) { planName = plan.name; planPrice = plan.price; days = plan.duration_days; }
    }

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + Number(days));

    // Purani subscription expire karo
    await supabaseAdmin
      .from('subscriptions')
      .update({ status: 'expired' })
      .eq('user_id', user_id)
      .eq('status', 'active');

    // Nayi manual subscription insert karo
    const { data: sub, error } = await supabaseAdmin
      .from('subscriptions')
      .insert({
        user_id,
        plan_id:    plan_id || null,
        plan_name:  planName,
        price:      planPrice,
        status:     'active',
        expires_at: expiresAt.toISOString(),
        razorpay_order_id:   'ADMIN_GRANT',
        razorpay_payment_id: 'ADMIN_GRANT'
      })
      .select().single();
    if (error) throw error;

    res.json({ success: true, subscription: sub });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── REVOKE PREMIUM MANUALLY (admin) ──
app.post('/api/admin/revoke-premium', auth, async (req, res) => {
  try {
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ success: false, error: 'user_id required' });

    // Seedha DELETE karo — sirf update nahi, row hatao
    const { error } = await supabaseAdmin
      .from('subscriptions')
      .delete()
      .eq('user_id', user_id);
    if (error) throw error;

    res.json({ success: true, message: 'Subscription removed successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── CHECK SUBSCRIPTION ──
app.get('/api/subscription', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    const user  = await getUserFromToken(token);
    if (!user?.id) return res.status(401).json({ success: false, error: 'Login zaroori hai' });

    const { data: sub } = await supabase
      .from('subscriptions')
      .select('*')
      .eq('user_id', user.id)
      .eq('status', 'active')
      .gte('expires_at', new Date().toISOString())
      .order('expires_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    res.json({ success: true, isPremium: !!sub, subscription: sub || null });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── CREATE RAZORPAY ORDER ──
app.post('/api/create-order', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    const user  = await getUserFromToken(token);
    if (!user?.id) return res.status(401).json({ success: false, error: 'Login zaroori hai' });

    // Razorpay keys check karo
    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
      return res.status(500).json({ success: false, error: 'Razorpay keys configure nahi hain (Railway env check karo)' });
    }

    const { plan_id } = req.body;
    if (!plan_id) return res.status(400).json({ success: false, error: 'plan_id required hai' });

    const { data: plan, error: planErr } = await supabaseAdmin
      .from('plans').select('*').eq('id', plan_id).single();
    if (planErr || !plan) return res.status(404).json({ success: false, error: 'Plan nahi mila: ' + (planErr?.message || 'not found') });

    const order = await razorpay.orders.create({
      amount:   Math.round(plan.price * 100),
      currency: 'INR',
      receipt:  `tt_${Date.now()}`,
      notes:    { plan_id: plan.id, user_id: user.id }
    });

    res.json({ success: true, order, plan });
  } catch (err) {
    console.error('create-order error:', err);
    res.status(500).json({ success: false, error: err.message || 'Order create nahi hua', details: err.error || null });
  }
});

// ── VERIFY PAYMENT + ACTIVATE SUBSCRIPTION ──
app.post('/api/verify-payment', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    const user  = await getUserFromToken(token);
    if (!user?.id) return res.status(401).json({ success: false, error: 'Login zaroori hai' });

    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, plan_id } = req.body;

    const expectedSig = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(razorpay_order_id + '|' + razorpay_payment_id)
      .digest('hex');

    if (expectedSig !== razorpay_signature) {
      return res.status(400).json({ success: false, error: 'Payment verification failed' });
    }

    const { data: plan } = await supabase
      .from('plans').select('*').eq('id', plan_id).single();
    if (!plan) throw new Error('Plan nahi mila');

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + plan.duration_days);

    await supabaseAdmin
      .from('subscriptions')
      .update({ status: 'expired' })
      .eq('user_id', user.id)
      .eq('status', 'active');

    const { data: sub, error: subError } = await supabaseAdmin
      .from('subscriptions')
      .insert({
        user_id:             user.id,
        plan_id:             plan.id,
        plan_name:           plan.name,
        price:               plan.price,
        status:              'active',
        expires_at:          expiresAt.toISOString(),
        razorpay_order_id,
        razorpay_payment_id
      })
      .select().single();
    if (subError) throw subError;

    res.json({ success: true, subscription: sub });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── MUSIC FILTER HELPERS ──

// Duration string (e.g. "3:45" or "1:02:30") ko seconds mein convert karo
function parseDurationToSeconds(durationStr) {
  if (!durationStr) return null;
  const parts = String(durationStr).split(':').map(Number);
  if (parts.length === 2) return parts[0] * 60 + parts[1];       // MM:SS
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]; // HH:MM:SS
  return null;
}

// Duration seconds se check karo — 60s to 600s (1 min to 10 min)
function isDurationValid(seconds) {
  if (seconds === null) return true; // duration pata nahi — allow karo
  return seconds >= 60 && seconds <= 600;
}

// Title mein music keywords check karo
const MUSIC_KEYWORDS = [
  'song','songs','music','audio','lyrics','lyric','official','video',
  'lofi','lo-fi','remix','cover','beats','beat','instrumental','ost',
  'soundtrack','album','single','ft.','feat','prod','version','mix',
  'slowed','reverb','sped up','nightcore','acoustic','unplugged',
  'full song','new song','latest song','hit song','trending','mashup',
  'jukebox','playlist','bhajan','ghazal','qawwali','rap','hip hop',
  'pop','rock','jazz','classical','folk','devotional','shayari'
];

const BLOCK_KEYWORDS = [
  'vlog','podcast','interview','trailer','teaser','review','unboxing',
  'tutorial','how to','recipe','cooking','gaming','gameplay','reaction',
  'commentary','news','debate','speech','lecture','documentary',
  'episode','season','series','movie','film','web series'
];

function isMusicByTitle(title) {
  if (!title) return false;
  const t = title.toLowerCase();
  // Block karo agar clearly non-music hai
  if (BLOCK_KEYWORDS.some(w => t.includes(w))) return false;
  // Allow karo agar music keyword hai
  if (MUSIC_KEYWORDS.some(w => t.includes(w))) return true;
  // No keyword found — duration pe depend karo (short = probably music)
  return null; // neutral
}

function validateMusic(title, durationSeconds) {
  const titleCheck = isMusicByTitle(title);
  const durValid   = isDurationValid(durationSeconds);

  // Block keywords mein hai → reject
  if (titleCheck === false) {
    return { ok: false, reason: `Yeh music nahi lagta: "${title}". Sirf songs add kar sakte ho.` };
  }
  // Duration bahut zyada hai → reject
  if (!durValid) {
    const mins = durationSeconds ? Math.round(durationSeconds / 60) : '?';
    return { ok: false, reason: `Video bahut lamba hai (${mins} min). Sirf songs add kar sakte ho (max 10 min).` };
  }
  return { ok: true };
}

// ── YT SEARCH — Results dikhao (PREMIUM ONLY) ──
app.post('/api/yt-search', premiumAuth, async (req, res) => {
  try {
    const { query } = req.body;
    if (!query || query.trim().length < 2) {
      return res.status(400).json({ success: false, error: 'Query too short' });
    }
    const searchRes = await fetch(
      `https://youtube-search-and-download.p.rapidapi.com/search?query=${encodeURIComponent(query)}&hl=en&gl=US&type=v`,
      {
        method: 'GET',
        headers: {
          'X-RapidAPI-Key':  process.env.RAPIDAPI_KEY,
          'X-RapidAPI-Host': 'youtube-search-and-download.p.rapidapi.com'
        }
      }
    );
    if (!searchRes.ok) throw new Error('YouTube search fail hua');
    const searchData = await searchRes.json();

    const allResults = (searchData?.contents || [])
      .filter(c => c?.video?.videoId)
      .map(c => {
        const durationSecs = parseDurationToSeconds(c.video.lengthText);
        return {
          videoId:       c.video.videoId,
          title:         c.video.title       || 'Unknown',
          channel:       c.video.channelName || 'Unknown',
          duration:      c.video.lengthText  || '',
          durationSecs,
          thumbnail:     `https://i.ytimg.com/vi/${c.video.videoId}/mqdefault.jpg`,
          views:         c.video.viewCountText || ''
        };
      });

    // Music filter — block non-music videos
    const results = allResults
      .filter(v => {
        const check = validateMusic(v.title, v.durationSecs);
        return check.ok;
      })
      .slice(0, 5)
      .map(({ durationSecs, ...v }) => v); // durationSecs frontend ko nahi chahiye

    if (!results.length) {
      // Agar sab filter ho gaye — unfiltered top 3 dikhao with warning
      const fallback = allResults.slice(0, 3).map(({ durationSecs, ...v }) => v);
      return res.json({ success: true, results: fallback, warning: 'Music results nahi mile, yeh related videos hain' });
    }
    res.json({ success: true, results });
  } catch (err) {
    console.error('yt-search error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── YT FETCH (PREMIUM ONLY) ──
app.post('/api/yt-fetch', premiumAuth, async (req, res) => {
  try {
    const { query, videoId: fixedVideoId, title: fixedTitle, channel: fixedChannel } = req.body;
    if (!query || query.trim().length < 2) {
      return res.status(400).json({ success: false, error: 'Query too short' });
    }

    let videoId, title, artist, thumbnail;

    if (fixedVideoId) {
      // User ne specific video choose kiya — uski info use karo
      videoId   = fixedVideoId;
      title     = fixedTitle  || query;
      artist    = fixedChannel || 'Unknown Artist';
      thumbnail = `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
    } else {
      // Search karke first result lo
      const searchRes = await fetch(
        `https://youtube-search-and-download.p.rapidapi.com/search?query=${encodeURIComponent(query)}&hl=en&gl=US&type=v`,
        {
          method: 'GET',
          headers: {
            'X-RapidAPI-Key':  process.env.RAPIDAPI_KEY,
            'X-RapidAPI-Host': 'youtube-search-and-download.p.rapidapi.com'
          }
        }
      );
      if (!searchRes.ok) throw new Error('YouTube search fail hua');
      const searchData = await searchRes.json();

      const firstResult = searchData?.contents?.[0]?.video;
      if (!firstResult?.videoId) {
        return res.status(404).json({ success: false, error: 'Koi video nahi mila' });
      }

      videoId   = firstResult.videoId;
      title     = firstResult.title       || query;
      artist    = firstResult.channelName || 'Unknown Artist';
      thumbnail = `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
    }

    const { data: existing } = await supabase
      .from('songs').select('*')
      .eq('youtube_url', `https://www.youtube.com/watch?v=${videoId}`)
      .maybeSingle();

    if (existing) {
      return res.json({
        success: true,
        song: {
          id: existing.id, title: existing.title, artist: existing.artist,
          thumbnail: existing.thumbnail, audioUrl: existing.audio_url,
          duration: existing.duration, quality: existing.quality
        }
      });
    }

    const rapidRes = await fetch(
      `https://youtube-mp36.p.rapidapi.com/dl?id=${videoId}`,
      {
        method: 'GET',
        headers: {
          'X-RapidAPI-Key':  process.env.RAPIDAPI_KEY,
          'X-RapidAPI-Host': 'youtube-mp36.p.rapidapi.com'
        }
      }
    );
    const rapidData = await rapidRes.json();
    if (rapidData.status !== 'ok' || !rapidData.link) {
      throw new Error('MP3 link nahi mila: ' + (rapidData.msg || 'Unknown error'));
    }

    // Music validation — duration + title check
    const durationSecs = rapidData.duration || null;
    const musicCheck   = validateMusic(title, durationSecs);
    if (!musicCheck.ok) {
      return res.status(422).json({ success: false, error: musicCheck.reason, code: 'NOT_MUSIC' });
    }

    const mp3Url   = rapidData.link;
    const duration = rapidData.duration
      ? `${Math.floor(rapidData.duration / 60)}:${String(rapidData.duration % 60).padStart(2, '0')}`
      : '0:00';

    const audioRes = await fetch(mp3Url);
    if (!audioRes.ok) throw new Error('Audio download failed');
    const audioBuffer = Buffer.from(await audioRes.arrayBuffer());

    const fileName = `${Date.now()}_${videoId}.mp3`;
    const { error: uploadError } = await supabase.storage
      .from('audio')
      .upload(fileName, audioBuffer, { contentType: 'audio/mpeg', upsert: false });
    if (uploadError) throw uploadError;

    const { data: { publicUrl: audioUrl } } = supabase.storage
      .from('audio')
      .getPublicUrl(fileName);

    const { data: song, error: dbError } = await supabaseAdmin
      .from('songs')
      .insert({
        title, artist, thumbnail,
        audio_url:   audioUrl,
        duration,
        quality:     '128kbps',
        youtube_url: `https://www.youtube.com/watch?v=${videoId}`
      })
      .select().single();
    if (dbError) throw dbError;

    res.json({
      success: true,
      song: {
        id: song.id, title: song.title, artist: song.artist,
        thumbnail: song.thumbnail, audioUrl: song.audio_url,
        duration: song.duration, quality: song.quality
      }
    });
  } catch (err) {
    console.error('YT Fetch Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── DELETE SONG ──
app.delete('/api/songs/:id', auth, async (req, res) => {
  try {
    const { error } = await supabaseAdmin
      .from('songs').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── UPDATE SONG ──
app.put('/api/songs/:id', auth, async (req, res) => {
  try {
    const { title, artist, thumbnail, audio_url, duration } = req.body;
    const { data, error } = await supabaseAdmin
      .from('songs')
      .update({ title, artist, thumbnail, audio_url, duration })
      .eq('id', req.params.id)
      .select().single();
    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── HEALTH ──
app.get('/', (req, res) => {
  res.json({ status: 'TubeTune API running!' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server on port ${PORT}`));
