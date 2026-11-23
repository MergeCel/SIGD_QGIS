'use strict';

/**
 * State terpusat sesuai ketentuan SK-4 Kelompok 11:
 * Mengontrol filter kelas bintang dan mode pengelompokan MarkerCluster.
 */
const state = {
  filters: {
    bintang5: true,
    bintang4: true,
    bintang3: true,
    lainnya: true,
  },
  cluster: false,
};

let showLabels = true;
let showKawasan = true;

/**
 * Skema 5 kelas gradasi harga_malam yang diselaraskan persis dengan
 * Graduated Symbology di QGIS (PjBL_Kel11.qgz / YlOrRd 5 kelas).
 */
const HARGA_CLASSES = [
  {
    min: 125000,
    max: 235000,
    color: '#ffffb2',
    textColor: '#0f172a',
    label: 'Rp 125.000 - Rp 235.000',
  },
  {
    min: 235000,
    max: 420000,
    color: '#fecc5c',
    textColor: '#0f172a',
    label: 'Rp 235.000 - Rp 420.000',
  },
  {
    min: 420000,
    max: 585000,
    color: '#fd8d3c',
    textColor: '#0f172a',
    label: 'Rp 420.000 - Rp 585.000',
  },
  {
    min: 585000,
    max: 845000,
    color: '#f03b20',
    textColor: '#ffffff',
    label: 'Rp 585.000 - Rp 845.000',
  },
  {
    min: 845000,
    max: 1390000,
    color: '#bd0026',
    textColor: '#ffffff',
    label: 'Rp 845.000 - Rp 1.390.000',
  },
];

function getHargaClass(harga) {
  const nilai = Number(harga) || 0;
  for (let i = 0; i < HARGA_CLASSES.length - 1; i += 1) {
    if (nilai <= HARGA_CLASSES[i].max) {
      return HARGA_CLASSES[i];
    }
  }
  return HARGA_CLASSES[HARGA_CLASSES.length - 1];
}

function getHargaColor(harga) {
  return getHargaClass(harga).color;
}

function escapeHtml(text) {
  return String(text ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatRupiah(value) {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    maximumFractionDigits: 0,
  }).format(Number(value) || 0);
}

/* -------------------------- Inisialisasi Peta -------------------------- */

const map = L.map('map').setView([-0.0565, 109.3295], 14);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

// Pane khusus kawasan hotel agar poligon selalu berada di bawah marker titik hotel.
map.createPane('kawasanPane');
map.getPane('kawasanPane').style.zIndex = 350;

let allHotelFeatures = [];
let activeHotelLayer = null;
let kawasanLayer = null;

// State untuk fitur digitasi poligon kawasan baru (POST /api/feature/kawasan)
let isDrawing = false;
let drawPoints = [];
const drawPreviewGroup = L.layerGroup().addTo(map);

/* ------------------------------ DOM Refs ------------------------------- */

const apiStatusEl = document.getElementById('api-status');
const hotelCounterEl = document.getElementById('hotel-counter');
const statsTotalEl = document.getElementById('stats-total');
const statsContainerEl = document.getElementById('stats-container');

const filterCheckboxes = {
  bintang5: document.getElementById('filter-bintang5'),
  bintang4: document.getElementById('filter-bintang4'),
  bintang3: document.getElementById('filter-bintang3'),
  lainnya: document.getElementById('filter-lainnya'),
};

const toggleClusterEl = document.getElementById('toggle-cluster');
const toggleLabelsEl = document.getElementById('toggle-labels');
const toggleKawasanEl = document.getElementById('toggle-kawasan');

const btnSelectAllEl = document.getElementById('btn-select-all');
const btnResetFiltersEl = document.getElementById('btn-reset-filters');

const inputNamaKawasanEl = document.getElementById('input-nama-kawasan');
const drawPointCountEl = document.getElementById('draw-point-count');
const drawStatusEl = document.getElementById('draw-status');
const btnDrawKawasanEl = document.getElementById('btn-draw-kawasan');
const btnSaveKawasanEl = document.getElementById('btn-save-kawasan');
const btnCancelKawasanEl = document.getElementById('btn-cancel-kawasan');

/* ------------------------- Legenda Peta Leaflet ------------------------ */

const legendControl = L.control({ position: 'bottomright' });
legendControl.onAdd = () => {
  const div = L.DomUtil.create('div', 'map-legend');
  const rowsHtml = HARGA_CLASSES.map(
    (cls) => `
      <div class="legend-item">
        <span class="legend-dot" style="background:${cls.color}"></span>
        <span>${cls.label}</span>
      </div>
    `,
  ).join('');

  div.innerHTML = `
    <h3>Harga / Malam (5 Kelas)</h3>
    ${rowsHtml}
    <hr class="legend-divider" />
    <div class="legend-item">
      <span class="legend-poly"></span>
      <span>Kawasan Hotel (Polygon)</span>
    </div>
  `;
  L.DomEvent.disableClickPropagation(div);
  return div;
};
legendControl.addTo(map);

/* --------------------------- Render Hotel ------------------------------ */

function matchesFilter(feature) {
  const bintang = Number(feature?.properties?.bintang);
  if (bintang === 5) return state.filters.bintang5;
  if (bintang === 4) return state.filters.bintang4;
  if (bintang === 3) return state.filters.bintang3;
  return state.filters.lainnya;
}

function createHotelPopupHtml(props) {
  const nama = escapeHtml(props.nama || 'Tanpa Nama');
  const bintang = Number(props.bintang) || 0;
  const kelas = escapeHtml(props.kelas || `${bintang} Bintang`);
  const harga = formatRupiah(props.harga_malam);
  const starsText = bintang > 0 ? '★'.repeat(bintang) : '-';

  const fasilitasList = String(props.fasilitas || '')
    .split('|')
    .map((item) => item.trim())
    .filter(Boolean);

  const fasilitasHtml =
    fasilitasList.length > 0
      ? fasilitasList.map((item) => `<span class="facility-chip">${escapeHtml(item)}</span>`).join('')
      : '<span class="muted-text">Tidak tersedia</span>';

  const lat = Number(props.latitude);
  const lng = Number(props.longitude);
  const coordsText =
    Number.isFinite(lat) && Number.isFinite(lng) ? `${lat.toFixed(6)}, ${lng.toFixed(6)}` : '-';

  return `
    <div class="hotel-popup">
      <div class="popup-header">
        <h3 class="popup-title">${nama}</h3>
        <span class="popup-kelas-badge">${starsText} · ${kelas}</span>
      </div>
      <p class="popup-price">${harga} / malam</p>
      <div class="popup-section-label">Fasilitas</div>
      <div class="facility-chips">${fasilitasHtml}</div>
      <div class="popup-coords">Koordinat: ${coordsText}</div>
    </div>
  `;
}

/**
 * Membuat L.divIcon agar kompatibel dengan Leaflet.markercluster
 * sekaligus tetap mempertahankan warna gradasi harga_malam.
 */
function createHotelDivIcon(props) {
  const cls = getHargaClass(props.harga_malam);
  const bintang = Number(props.bintang) || 0;
  return L.divIcon({
    className: 'hotel-div-icon',
    html: `<div class="hotel-div-badge" style="background:${cls.color};color:${cls.textColor};">★${bintang}</div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    popupAnchor: [0, -14],
  });
}

function createHaloLabelHtml(props) {
  const nama = escapeHtml(props.nama || '');
  const bintang = Number(props.bintang) || 0;
  const kelas = escapeHtml(props.kelas || `${bintang} Bintang`);
  return `${nama}<span class="hotel-halo-sub">${kelas}</span>`;
}

/**
 * Fungsi render utama yang membaca state terpusat (`state.filters` & `state.cluster`)
 * lalu menghapus layer lama dan merender ulang marker ke peta.
 */
function renderHotel() {
  if (activeHotelLayer) {
    map.removeLayer(activeHotelLayer);
    activeHotelLayer = null;
  }

  const filteredFeatures = allHotelFeatures.filter(matchesFilter);
  hotelCounterEl.textContent = `Menampilkan ${filteredFeatures.length} dari ${allHotelFeatures.length} Hotel`;

  const featureCollection = {
    type: 'FeatureCollection',
    features: filteredFeatures,
  };

  if (state.cluster) {
    const clusterGroup = L.markerClusterGroup({
      showCoverageOnHover: false,
      maxClusterRadius: 50,
    });

    const geoJsonLayer = L.geoJSON(featureCollection, {
      pointToLayer: (feature, latlng) => {
        const props = feature.properties || {};
        return L.marker(latlng, {
          icon: createHotelDivIcon(props),
          title: props.nama || '',
        });
      },
      onEachFeature: (feature, layer) => {
        const props = feature.properties || {};
        layer.bindPopup(createHotelPopupHtml(props));
      },
    });

    clusterGroup.addLayer(geoJsonLayer);
    clusterGroup.addTo(map);
    activeHotelLayer = clusterGroup;
    return;
  }

  const geoJsonLayer = L.geoJSON(featureCollection, {
    pointToLayer: (feature, latlng) => {
      const props = feature.properties || {};
      return L.circleMarker(latlng, {
        radius: 9,
        fillColor: getHargaColor(props.harga_malam),
        color: '#1e293b',
        weight: 1.8,
        opacity: 1,
        fillOpacity: 0.92,
      });
    },
    onEachFeature: (feature, layer) => {
      const props = feature.properties || {};
      layer.bindPopup(createHotelPopupHtml(props));

      const bintang = Number(props.bintang) || 0;
      if (showLabels && bintang >= 3) {
        layer.bindTooltip(createHaloLabelHtml(props), {
          permanent: true,
          direction: 'right',
          offset: [10, 0],
          className: 'hotel-halo-tooltip',
        });
      }
    },
  });

  geoJsonLayer.addTo(map);
  activeHotelLayer = geoJsonLayer;
}

/* ------------------------ Load Data dari API --------------------------- */

function setApiStatus(type, text) {
  apiStatusEl.className = `status-pill ${type}`;
  apiStatusEl.textContent = text;
}

async function loadHotelData() {
  const response = await fetch('/api/data/hotel');
  if (!response.ok) {
    throw new Error(`Gagal memuat data hotel (HTTP ${response.status}).`);
  }

  const geojson = await response.json();
  allHotelFeatures = Array.isArray(geojson.features) ? geojson.features : [];
  renderHotel();
}

async function loadStatsBintang() {
  const response = await fetch('/api/stats/bintang');
  if (!response.ok) {
    throw new Error(`Gagal memuat statistik bintang (HTTP ${response.status}).`);
  }

  const result = await response.json();
  const total = Number(result.total) || 0;
  const rows = Array.isArray(result.data) ? [...result.data].sort((a, b) => b.bintang - a.bintang) : [];

  statsTotalEl.textContent = `Total: ${total} hotel`;

  if (rows.length === 0) {
    statsContainerEl.innerHTML = '<p class="muted-text">Belum ada data statistik.</p>';
    return;
  }

  statsContainerEl.innerHTML = rows
    .map(({ bintang, jumlah }) => {
      const pct = total > 0 ? Math.round((jumlah / total) * 100) : 0;
      return `
        <div class="stat-item">
          <div class="stat-row-top">
            <span>Bintang ${escapeHtml(bintang)} (${'★'.repeat(Number(bintang) || 0)})</span>
            <span>${jumlah} hotel (${pct}%)</span>
          </div>
          <div class="stat-bar-track">
            <div class="stat-bar-fill" style="width: ${pct}%"></div>
          </div>
        </div>
      `;
    })
    .join('');
}

async function loadKawasanData() {
  const response = await fetch('/api/data/kawasan');
  if (!response.ok) {
    throw new Error(`Gagal memuat data kawasan (HTTP ${response.status}).`);
  }

  const geojson = await response.json();

  if (kawasanLayer) {
    map.removeLayer(kawasanLayer);
    kawasanLayer = null;
  }

  const features = Array.isArray(geojson.features) ? geojson.features : [];

  kawasanLayer = L.geoJSON(geojson, {
    pane: 'kawasanPane',
    style: {
      fillColor: '#becf50',
      color: '#4d5e10',
      weight: 2,
      opacity: 0.9,
      fillOpacity: 0.45,
    },
    onEachFeature: (feature, layer) => {
      const idx = features.indexOf(feature);
      const nama = escapeHtml(feature?.properties?.nama_kawasan || 'Kawasan Hotel');
      const isLocked =
        (feature?.properties?.fid !== undefined && feature?.properties?.fid !== null) ||
        Boolean(feature?.properties?.locked);

      const actionHtml = isLocked
        ? '<span class="locked-badge">Data Bawaan SK-2 (Terkunci)</span>'
        : `<button type="button" class="btn btn-danger btn-sm btn-delete-kawasan" data-index="${idx}">
            Hapus Kawasan
          </button>`;

      layer.bindPopup(`
        <div class="hotel-popup">
          <h3 class="popup-title">${nama}</h3>
          <p class="muted-text" style="margin-top:4px;">Poligon Kawasan Hotel</p>
          ${actionHtml}
        </div>
      `);

      if (!isLocked) {
        layer.on('popupopen', (event) => {
          const popupEl = event.popup.getElement();
          const deleteBtn = popupEl?.querySelector('.btn-delete-kawasan');
          if (!deleteBtn) return;

          deleteBtn.addEventListener('click', () => {
            deleteKawasan(idx, deleteBtn);
          });
        });
      }
    },
  });

  if (showKawasan) {
    kawasanLayer.addTo(map);
  }
}

async function deleteKawasan(index, buttonEl) {
  if (index < 0) return;
  if (buttonEl) {
    buttonEl.disabled = true;
    buttonEl.textContent = 'Menghapus...';
  }

  try {
    const response = await fetch(`/api/feature/kawasan/${index}`, {
      method: 'DELETE',
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok || !data.ok) {
      throw new Error(data.error || `Gagal menghapus kawasan (HTTP ${response.status}).`);
    }

    await loadKawasanData();
    setDrawStatus(`Kawasan dihapus (${data.total} tersisa).`, 'is-success');
  } catch (error) {
    setDrawStatus(error.message || 'Gagal menghapus kawasan.', 'is-error');
    if (buttonEl) {
      buttonEl.disabled = false;
      buttonEl.textContent = 'Hapus Kawasan';
    }
  }
}

/* --------------------- Digitasi Poligon Kawasan Baru ------------------- */

function setDrawStatus(text, statusClass = '') {
  drawStatusEl.textContent = text;
  drawStatusEl.className = statusClass ? `draw-status ${statusClass}` : 'draw-status';
}

function updateDrawUi() {
  drawPointCountEl.textContent = `Titik dipilih: ${drawPoints.length}`;
  btnDrawKawasanEl.disabled = isDrawing;
  btnCancelKawasanEl.disabled = !isDrawing && drawPoints.length === 0;
  btnSaveKawasanEl.disabled = !isDrawing || drawPoints.length < 3;
  map.getContainer().classList.toggle('drawing-mode', isDrawing);
}

function renderDrawPreview() {
  drawPreviewGroup.clearLayers();
  if (drawPoints.length === 0) return;

  const latLngs = drawPoints.map(([lng, lat]) => [lat, lng]);

  for (const [lat, lng] of latLngs) {
    L.circleMarker([lat, lng], {
      radius: 5,
      color: '#0f4c81',
      fillColor: '#ffffff',
      weight: 2,
      fillOpacity: 1,
    }).addTo(drawPreviewGroup);
  }

  if (latLngs.length >= 3) {
    L.polygon(latLngs, {
      color: '#0f4c81',
      weight: 2,
      dashArray: '5, 5',
      fillColor: '#38bdf8',
      fillOpacity: 0.25,
    }).addTo(drawPreviewGroup);
  } else if (latLngs.length === 2) {
    L.polyline(latLngs, {
      color: '#0f4c81',
      weight: 2,
      dashArray: '5, 5',
    }).addTo(drawPreviewGroup);
  }
}

function resetDrawing(statusText = 'Siap menggambar', statusClass = '') {
  isDrawing = false;
  drawPoints = [];
  drawPreviewGroup.clearLayers();
  setDrawStatus(statusText, statusClass);
  updateDrawUi();
}

async function submitKawasanBaru() {
  if (drawPoints.length < 3) {
    setDrawStatus('Minimal 3 titik sudut diperlukan.', 'is-error');
    return;
  }

  const namaKawasan = inputNamaKawasanEl.value.trim();
  if (!namaKawasan) {
    setDrawStatus('Isi nama kawasan terlebih dahulu.', 'is-error');
    inputNamaKawasanEl.focus();
    return;
  }

  // Tutup ring poligon agar titik awal === titik akhir (minimal 4 koordinat) sesuai backend.
  const ring = drawPoints.map(([lng, lat]) => [Number(lng.toFixed(6)), Number(lat.toFixed(6))]);
  ring.push([...ring[0]]);

  const payload = {
    feature: {
      type: 'Feature',
      properties: {
        nama_kawasan: namaKawasan,
      },
      geometry: {
        type: 'Polygon',
        coordinates: [ring],
      },
    },
  };

  btnSaveKawasanEl.disabled = true;
  setDrawStatus('Menyimpan ke server...', 'is-active');

  try {
    const response = await fetch('/api/feature/kawasan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      throw new Error(data.error || `Gagal menyimpan (HTTP ${response.status}).`);
    }

    inputNamaKawasanEl.value = '';
    showKawasan = true;
    toggleKawasanEl.checked = true;
    await loadKawasanData();
    resetDrawing(`Tersimpan (${data.total} kawasan).`, 'is-success');
  } catch (error) {
    setDrawStatus(error.message || 'Gagal menyimpan kawasan.', 'is-error');
    updateDrawUi();
  }
}

/* --------------------------- Event Listeners --------------------------- */

function syncFilterCheckboxesFromState() {
  for (const [key, checkbox] of Object.entries(filterCheckboxes)) {
    checkbox.checked = state.filters[key];
  }
  toggleClusterEl.checked = state.cluster;
}

for (const [key, checkbox] of Object.entries(filterCheckboxes)) {
  checkbox.addEventListener('change', () => {
    state.filters[key] = checkbox.checked;
    renderHotel();
  });
}

btnSelectAllEl.addEventListener('click', () => {
  state.filters.bintang5 = true;
  state.filters.bintang4 = true;
  state.filters.bintang3 = true;
  state.filters.lainnya = true;
  syncFilterCheckboxesFromState();
  renderHotel();
});

btnResetFiltersEl.addEventListener('click', () => {
  state.filters.bintang5 = true;
  state.filters.bintang4 = true;
  state.filters.bintang3 = true;
  state.filters.lainnya = true;
  state.cluster = false;
  syncFilterCheckboxesFromState();
  renderHotel();
});

toggleClusterEl.addEventListener('change', () => {
  state.cluster = toggleClusterEl.checked;
  renderHotel();
});

toggleLabelsEl.addEventListener('change', () => {
  showLabels = toggleLabelsEl.checked;
  renderHotel();
});

toggleKawasanEl.addEventListener('change', () => {
  showKawasan = toggleKawasanEl.checked;
  if (!kawasanLayer) return;

  if (showKawasan) {
    kawasanLayer.addTo(map);
  } else {
    map.removeLayer(kawasanLayer);
  }
});

btnDrawKawasanEl.addEventListener('click', () => {
  isDrawing = true;
  drawPoints = [];
  drawPreviewGroup.clearLayers();
  setDrawStatus('Klik peta untuk menambah titik poligon', 'is-active');
  updateDrawUi();
});

btnCancelKawasanEl.addEventListener('click', () => {
  resetDrawing('Dibatalkan');
});

btnSaveKawasanEl.addEventListener('click', () => {
  submitKawasanBaru();
});

map.on('click', (event) => {
  if (!isDrawing) return;
  drawPoints.push([event.latlng.lng, event.latlng.lat]);
  renderDrawPreview();
  setDrawStatus(
    drawPoints.length < 3 ? 'Minimal 3 titik diperlukan' : 'Siap disimpan ke server',
    'is-active',
  );
  updateDrawUi();
});

/* ------------------------------ Bootstrap ------------------------------ */

async function initApp() {
  try {
    setApiStatus('status-loading', 'Memuat API...');
    await Promise.all([loadHotelData(), loadStatsBintang(), loadKawasanData()]);
    setApiStatus('status-ok', 'API Terhubung');
  } catch (error) {
    console.error('[initApp]', error);
    setApiStatus('status-error', 'Gagal Memuat API');
    hotelCounterEl.textContent = 'Data gagal dimuat';
    statsContainerEl.innerHTML = `<p class="muted-text">${escapeHtml(error.message)}</p>`;
  }
}

initApp();
