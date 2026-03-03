// ── YT FETCH BY QUERY (Auto-search + upload) ──
app.post('/api/yt-fetch', async (req, res) => {
  try {
    const { query } = req.body;
    if (!query || query.trim().length < 2) {
      return res.status(400).json({ success: false, error: 'Query too short' });
    }

    // Step 1: YouTube pe search karo (RapidAPI YouTube Search)
    const searchRes = await fetch(
      `https://youtube-search-and-download.p.rapidapi.com/search?query=${encodeURIComponent(query)}&hl=en&gl=US&type=v`,
      {
        method: 'GET',
        headers: {
          'X-RapidAPI-Key': process.env.RAPIDAPI_KEY,
          'X-RapidAPI-Host': 'youtube-search-and-download.p.rapidapi.com'
        }
      }
    );

    if (!searchRes.ok) throw new Error('YouTube search fail hua');
    const searchData = await searchRes.json();

    // Pehla result lo
    const firstResult = searchData?.contents?.[0]?.video;
    if (!firstResult?.videoId) {
      return res.status(404).json({ success: false, error: 'Koi video nahi mila' });
    }

    const videoId  = firstResult.videoId;
    const title    = firstResult.title    || query;
    const artist   = firstResult.channelName || 'Unknown Artist';
    const thumbnail = `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;

    // Step 2: Check karo — yeh song pehle se database mein toh nahi?
    const { data: existing } = await supabase
      .from('songs')
      .select('*')
      .eq('youtube_url', `https://www.youtube.com/watch?v=${videoId}`)
      .maybeSingle();

    if (existing) {
      // Pehle se hai — wahi return karo
      return res.json({
        success: true,
        song: {
          id:        existing.id,
          title:     existing.title,
          artist:    existing.artist,
          thumbnail: existing.thumbnail,
          audioUrl:  existing.audio_url,
          duration:  existing.duration,
          quality:   existing.quality
        }
      });
    }

    // Step 3: RapidAPI se MP3 URL lo (same as /api/upload)
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
    if (rapidData.status !== 'ok' || !rapidData.link) {
      throw new Error('MP3 link nahi mila: ' + (rapidData.msg || 'Unknown error'));
    }

    const mp3Url  = rapidData.link;
    const duration = rapidData.duration
      ? `${Math.floor(rapidData.duration / 60)}:${String(rapidData.duration % 60).padStart(2, '0')}`
      : '0:00';

    // Step 4: MP3 download karo
    const audioRes = await fetch(mp3Url);
    if (!audioRes.ok) throw new Error('Audio download failed');
    const audioBuffer = Buffer.from(await audioRes.arrayBuffer());

    // Step 5: Supabase Storage pe upload
    const fileName = `${Date.now()}_${videoId}.mp3`;
    const { error: uploadError } = await supabase.storage
      .from('audio')
      .upload(fileName, audioBuffer, { contentType: 'audio/mpeg', upsert: false });
    if (uploadError) throw uploadError;

    // Step 6: Public URL lo
    const { data: { publicUrl: audioUrl } } = supabase.storage
      .from('audio')
      .getPublicUrl(fileName);

    // Step 7: Database mein save karo
    const { data: song, error: dbError } = await supabase
      .from('songs')
      .insert({
        title,
        artist,
        thumbnail,
        audio_url:   audioUrl,
        duration,
        quality:     '128kbps',
        youtube_url: `https://www.youtube.com/watch?v=${videoId}`
      })
      .select()
      .single();
    if (dbError) throw dbError;

    res.json({
      success: true,
      song: {
        id:        song.id,
        title:     song.title,
        artist:    song.artist,
        thumbnail: song.thumbnail,
        audioUrl:  song.audio_url,
        duration:  song.duration,
        quality:   song.quality
      }
    });

  } catch (err) {
    console.error('YT Fetch Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});
