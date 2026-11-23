'use strict';

const express = require('express');
const fsp = require('node:fs/promises');
const path = require('node:path');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');

/**
 * Pemetaan nama layer pada URL ke file GeoJSON di folder data/.
 *
 * Sengaja memakai pemetaan eksplisit (bukan route generik yang memakai nama
 * file mentah) agar frontend tetap memakai /api/data/hotel walaupun nama file
 * sebenarnya hotel_south.geojson. Frontend WAJIB memakai URL yang sama.
 */
const LAYERS = {
  hotel: 'hotel_south.geojson',
  kawasan: 'kawasan_hotel.geojson',
};

app.disable('x-powered-by');
app.use(express.json({ limit: '5mb' }));
app.use(express.static(PUBLIC_DIR));

/* --------------------------------- File --------------------------------- */

function resolveDataFile(fileName) {
  return path.join(DATA_DIR, fileName);
}

async function readGeoJson(fileName) {
  const raw = await fsp.readFile(resolveDataFile(fileName), 'utf8');

  try {
    return JSON.parse(raw);
  } catch (cause) {
    // Jangan biarkan JSON.parse yang gagal membuat proses server crash.
    const error = new Error(`File ${fileName} rusak: isinya bukan JSON yang valid.`);
    error.status = 500;
    error.cause = cause;
    throw error;
  }
}

async function writeGeoJson(fileName, geojson) {
  const target = resolveDataFile(fileName);
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;

  // Tulis ke file sementara lalu rename agar file utama tidak setengah tertulis.
  await fsp.writeFile(temp, `${JSON.stringify(geojson, null, 2)}\n`, 'utf8');
  await fsp.rename(temp, target);
}

async function ensureKawasanFile() {
  const fileName = LAYERS.kawasan;

  try {
    await fsp.access(resolveDataFile(fileName));
  } catch {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    await writeGeoJson(fileName, {
      type: 'FeatureCollection',
      name: 'kawasan_hotel',
      features: [],
    });
    console.log(`[init] File data/${fileName} belum ada, dibuat sebagai FeatureCollection kosong.`);
  }
}

/* ------------------------------- Validasi ------------------------------- */

/**
 * Mengembalikan pesan error (string) jika feature tidak valid,
 * atau null jika valid. Hanya Polygon yang diterima sesuai brief.
 */
function validateKawasanFeature(feature) {
  if (feature === undefined || feature === null) {
    return 'Field "feature" wajib diisi.';
  }

  if (typeof feature !== 'object' || Array.isArray(feature)) {
    return 'Field "feature" harus berupa objek GeoJSON Feature.';
  }

  if (feature.type !== 'Feature') {
    return 'feature.type harus "Feature".';
  }

  if (!feature.geometry || feature.geometry.type !== 'Polygon') {
    return 'Geometri kawasan harus bertipe Polygon.';
  }

  const rings = feature.geometry.coordinates;
  if (!Array.isArray(rings) || rings.length === 0) {
    return 'Koordinat Polygon tidak boleh kosong.';
  }

  const isPosition = (position) =>
    Array.isArray(position) &&
    position.length >= 2 &&
    Number.isFinite(position[0]) &&
    Number.isFinite(position[1]) &&
    position[0] >= -180 &&
    position[0] <= 180 &&
    position[1] >= -90 &&
    position[1] <= 90;

  for (const ring of rings) {
    if (!Array.isArray(ring) || ring.length < 4) {
      return 'Setiap ring Polygon minimal berisi 4 titik.';
    }

    if (!ring.every(isPosition)) {
      return 'Setiap koordinat harus [longitude, latitude] berupa angka yang valid.';
    }

    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
      return 'Ring Polygon harus tertutup (titik awal sama dengan titik akhir).';
    }
  }

  return null;
}

/* --------------------------------- Route -------------------------------- */

// GET /api/data/hotel -> isi hotel_south.geojson (GeoJSON mentah untuk Leaflet)
app.get('/api/data/:layer', async (req, res, next) => {
  try {
    const fileName = LAYERS[req.params.layer];

    if (!fileName) {
      return res.status(404).json({
        ok: false,
        error: `Layer "${req.params.layer}" tidak dikenal. Pilihan: ${Object.keys(LAYERS).join(', ')}.`,
      });
    }

    const geojson = await readGeoJson(fileName);
    return res.json(geojson);
  } catch (error) {
    return next(error);
  }
});

// GET /api/stats/bintang -> jumlah hotel per nilai bintang (1-5)
app.get('/api/stats/bintang', async (req, res, next) => {
  try {
    const geojson = await readGeoJson(LAYERS.hotel);
    const features = Array.isArray(geojson.features) ? geojson.features : [];

    const counts = new Map();
    for (let bintang = 1; bintang <= 5; bintang += 1) {
      counts.set(bintang, 0);
    }

    for (const feature of features) {
      const bintang = Number(feature?.properties?.bintang);
      if (!Number.isFinite(bintang)) continue;

      counts.set(bintang, (counts.get(bintang) ?? 0) + 1);
    }

    const data = [...counts.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([bintang, jumlah]) => ({ bintang, jumlah }));

    return res.json({ ok: true, total: features.length, data });
  } catch (error) {
    return next(error);
  }
});

// POST /api/feature/kawasan -> tambah satu Polygon ke kawasan_hotel.geojson
app.post('/api/feature/kawasan', async (req, res, next) => {
  try {
    const feature = req.body?.feature;
    const validationError = validateKawasanFeature(feature);

    if (validationError) {
      return res.status(400).json({ ok: false, error: validationError });
    }

    const geojson = await readGeoJson(LAYERS.kawasan);
    if (!Array.isArray(geojson.features)) {
      geojson.features = [];
    }

    geojson.features.push(feature);
    await writeGeoJson(LAYERS.kawasan, geojson);

    // Format disepakati: 201 + { ok, total }.
    return res.status(201).json({ ok: true, total: geojson.features.length });
  } catch (error) {
    return next(error);
  }
});

// GET / -> status backend. Jika public/index.html sudah ada (frontend bagian 3),
// express.static di atas yang akan menyajikannya dan route ini tidak terpakai.
app.get('/', (req, res) => {
  return res.json({
    ok: true,
    message: 'Backend UAS QGIS aktif. Frontend Leaflet (bagian 3) belum dipasang di public/.',
    endpoints: [
      { method: 'GET', path: '/api/data/hotel', keterangan: 'GeoJSON hotel' },
      { method: 'GET', path: '/api/stats/bintang', keterangan: 'Jumlah hotel per nilai bintang' },
      { method: 'POST', path: '/api/feature/kawasan', keterangan: 'Simpan polygon kawasan' },
    ],
  });
});

/* ----------------------------- Error handler ---------------------------- */

// Body JSON tidak valid / terlalu besar.
app.use((error, req, res, next) => {
  if (error.type === 'entity.parse.failed') {
    return res.status(400).json({ ok: false, error: 'Body request bukan JSON yang valid.' });
  }

  if (error.type === 'entity.too.large') {
    return res.status(413).json({ ok: false, error: 'Body request terlalu besar.' });
  }

  return next(error);
});

// 404 khusus API supaya frontend selalu menerima JSON, bukan halaman HTML.
app.use('/api', (req, res) => {
  res.status(404).json({ ok: false, error: 'Endpoint API tidak ditemukan.' });
});

// Handler terakhir: file hilang, JSON rusak, atau error tak terduga.
app.use((error, req, res, next) => {
  if (res.headersSent) {
    return next(error);
  }

  const status = error.status || error.statusCode || (error.code === 'ENOENT' ? 404 : 500);
  const message =
    status === 404
      ? 'File data tidak ditemukan. Pastikan file GeoJSON sudah ada di folder data/.'
      : status >= 500
        ? 'Terjadi kesalahan pada server saat membaca/menulis data.'
        : error.message;

  console.error(`[error] ${req.method} ${req.originalUrl} -> ${status}`, error);
  return res.status(status).json({ ok: false, error: message });
});

/* --------------------------------- Start -------------------------------- */

async function start() {
  await ensureKawasanFile();

  const server = app.listen(PORT, () => {
    console.log(`Server berjalan di http://localhost:${PORT}`);
    console.log('  GET  /api/data/hotel');
    console.log('  GET  /api/stats/bintang');
    console.log('  POST /api/feature/kawasan');
  });

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(
        `Port ${PORT} sudah dipakai. Hentikan proses lain atau jalankan dengan PORT lain, ` +
          `misalnya: PORT=3100 npm start (PowerShell: $env:PORT=3100; npm start).`,
      );
      process.exitCode = 1;
      return;
    }

    console.error('Gagal menjalankan server:', error);
    process.exitCode = 1;
  });
}

start().catch((error) => {
  console.error('Gagal menjalankan server:', error);
  process.exitCode = 1;
});
