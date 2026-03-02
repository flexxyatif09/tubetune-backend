const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const ytdl = require('ytdl-core');
const { Readable } = require('stream');

const app = express();
app.use(cors());
app.use(express.json());

// Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ── AUTH MIDDLEWARE ──
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
      .range(offset, offset + limit - 1);

    if (search) {
      query = query.or(
        `title.ilike.%${search}%,artist.ilike.%${search}%`
      );
    }

    const { data, error, count } = await query;
    if (error) throw error;

    res.json({ success: true, total: count, data });
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

    if (!ytdl.validateURL(url)) {
      return res.status(400).json({ error: 'Invalid YouTube URL' });
    }

    // Get video info
    const info = await ytdl.getInfo(url);
    const title = info.videoDetails.title;
    const artist = info.videoDetails.author.name;
    const thumbnail = info.videoDetails.thumbnails.pop().url;
    const duration_sec = parseInt(info.videoDetails.lengthSeconds);
    const mins = Math.floor(duration_sec / 60);
    const secs = String(duration_sec % 60).padStart(2, '0');
    const duration = `${mins}:${secs}`;

    // Download audio as buffer
    const audioStream = ytdl(url, {
      quality: 'highestaudio',
      filter: 'audioonly'
    });

    const chunks = [];
    for await (const chunk of audioStream) {
      chunks.push(chunk);
    }
    const audioBuffer = Buffer.concat(chunks);

    // Upload audio to Supabase Storage
    const audioFileName = `${Date.now()}_${title.replace(/[^a-z0-9]/gi, '_')}.mp3`;

    const { data: audioUpload, error: audioError } = await supabase
      .storage
      .from('audio')
      .upload(audioFileName, audioBuffer, {
        contentType: 'audio/mpeg'
      });

    if (audioError) throw audioError;

    // Get public URL
    const { data: { publicUrl: audioUrl } } = supabase
      .storage
      .from('audio')
      .getPublicUrl(audioFileName);

    // Save to database
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
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE SONG ──
app.delete('/api/songs/:id', auth, async (req, res) => {
  try {
    const { error } = await supabase
      .from('songs')
      .delete()
      .eq('id', req.params.id);

    if (error) throw error;
    res.json({ success: true, message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── STATS ──
app.get('/api/stats', async (req, res) => {
  const { count } = await supabase
    .from('songs')
    .select('*', { count: 'exact', head: true });
  res.json({ total: count });
});

// ── HEALTH CHECK ──
app.get('/', (req, res) => {
  res.json({ status: 'TubeTune API running!' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server on port ${PORT}`));
