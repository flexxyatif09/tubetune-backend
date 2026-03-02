const fetch = require('node-fetch');
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

function auth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
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

// ── UPLOAD SONG ──
app.post('/api/upload', auth, async (req, res) => {
  try {
    const { url, quality = '320' } = req.body;

    if (!url || (!url.includes('youtube.com') && !url.includes('youtu.be'))) {
      return res.status(400).json({ error: 'Invalid YouTube URL' });
    }

    // Video ID nikalo
    let videoId = '';
    if (url.includes('watch?v=')) {
      videoId = url.split('watch?v=')[1].split('&')[0];
    } else if (url.includes('youtu.be/')) {
      videoId = url.split('youtu.be/')[1].split('?')[0];
    }
    if (!videoId) return res.status(400).json({ error: 'Invalid URL' });

    // Step 1: Title aur thumbnail
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
        title = oData.title || title;
        artist = oData.author_name || artist;
      }
    } catch(e) { console.log('oembed:', e.message); }

    // Step 2: RapidAPI se MP3 URL lo
    const rapidRes = await fetch(
      `https://youtube-mp36.p.rapidapi.com/dl?id=${videoId}`,
      {
        method: 'GET',
        headers: {
          'X-RapidAPI-Key': process.env.RAPIDAPI_KEY,
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

    // Step 3: MP3 download karo
    const audioRes = await fetch(mp3Url);
    if (!audioRes.ok) throw new Error('Audio download failed');
    const audioBuffer = Buffer.from(await audioRes.arrayBuffer());

    // Step 4: Supabase Storage pe upload
    const fileName = `${Date.now()}_${videoId}.mp3`;
    const { error: uploadError } = await supabase.storage
      .from('audio')
      .upload(fileName, audioBuffer, {
        contentType: 'audio/mpeg',
        upsert: false
      });
    if (uploadError) throw uploadError;

    // Step 5: Public URL
    const { data: { publicUrl: audioUrl } } = supabase.storage
      .from('audio')
      .getPublicUrl(fileName);

    // Step 6: Database save
    const { data: song, error: dbError } = await supabase
      .from('songs')
      .insert({
        title,
        artist,
        thumbnail,
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
        id: song.id,
        title: song.title,
        artist: song.artist,
        thumbnail: song.thumbnail,
        audioUrl: song.audio_url,
        duration: song.duration,
        quality: song.quality
      }
    });

  } catch (err) {
    console.error('Upload error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE SONG ──
app.delete('/api/songs/:id', auth, async (req, res) => {
  try {
    const { error } = await supabase
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
    const { data, error } = await supabase
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
