// ── DOM refs ───────────────────────────────────────────────────────────────
const landingPage    = document.getElementById('landing-page');
const mapView        = document.getElementById('map-view');
const stopsContainer = document.getElementById('stops-container');
const routeError     = document.getElementById('route-error');
const mapTitle       = document.getElementById('map-title');

const btnAddStop    = document.getElementById('btn-add-stop');
const btnEnterRoute = document.getElementById('btn-enter-route');
const btnBack       = document.getElementById('btn-back');

// ── Leaflet map (initialized once) ────────────────────────────────────────
let map = null;
let routeLayer   = null;
let markerGroup  = null;
let legendControl = null;

function initMap() {
    if (map) return;
    map = L.map('map', { center: [41.6, -72.7], zoom: 9, zoomControl: true });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
    markerGroup = L.layerGroup().addTo(map);
}

// ── Geocoding via Nominatim ────────────────────────────────────────────────
async function geocode(query) {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1&countrycodes=us`;
    const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
    if (!res.ok) throw new Error('Geocoding request failed');
    const data = await res.json();
    if (!data.length) throw new Error(`Could not find location: "${query}"`);
    return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon), name: data[0].display_name };
}

// ── Routing via OSRM ──────────────────────────────────────────────────────
async function getRoutes(waypoints) {
    const coords = waypoints.map(p => `${p.lon},${p.lat}`).join(';');
    const url = `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson&alternatives=3`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('Routing request failed');
    const data = await res.json();
    if (data.code !== 'Ok') throw new Error('No route found between those locations');
    return data.routes; // array; [0] is always fastest
}

// Score a route by crashes per km — lower is safer
function crashScorePerKm(geometry, crashes, distanceM) {
    if (!distanceM) return 0;
    const coords = geometry.coordinates;
    let count = 0;
    for (const feature of crashes) {
        const [lon, lat] = feature.geometry.coordinates;
        if (!isFinite(lat) || !isFinite(lon)) continue;
        for (let i = 0; i < coords.length - 1; i++) {
            const [alon, alat] = coords[i];
            const [blon, blat] = coords[i + 1];
            if (distToSegmentM(lat, lon, alat, alon, blat, blon) <= CRASH_BUFFER_M) {
                count++;
                break;
            }
        }
    }
    return count / (distanceM / 1000);
}

async function pickRoute(routes) {
    if (_routeMode === 'faster' || routes.length === 1) return routes[0].geometry;

    // Combined bbox of all alternatives for a single crash fetch
    let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity;
    for (const route of routes) {
        for (const [lon, lat] of route.geometry.coordinates) {
            if (lat < minLat) minLat = lat;
            if (lon < minLon) minLon = lon;
            if (lat > maxLat) maxLat = lat;
            if (lon > maxLon) maxLon = lon;
        }
    }
    const crashes = await fetchCrashesInBounds(minLat, minLon, maxLat, maxLon);

    let best = routes[0], bestScore = Infinity;
    for (const route of routes) {
        const score = crashScorePerKm(route.geometry, crashes, route.distance);
        if (score < bestScore) { bestScore = score; best = route; }
    }
    return best.geometry;
}

// ── Marker icons ───────────────────────────────────────────────────────────
function makeIcon(color, label) {
    return L.divIcon({
        className: '',
        html: `<div style="
            background:${color};color:#fff;border:2px solid #fff;border-radius:50%;
            width:28px;height:28px;display:flex;align-items:center;justify-content:center;
            font-size:11px;font-weight:700;box-shadow:0 2px 6px rgba(0,0,0,0.35);
            font-family:system-ui,sans-serif;">${label}</div>`,
        iconSize: [28, 28],
        iconAnchor: [14, 14],
    });
}

// ── CT Crash Data constants ────────────────────────────────────────────────
const CRASH_API      = 'https://gis.cti.uconn.edu/arcgis/rest/services/Crash_Dashboards/ConnecticutCrash/FeatureServer/0/query';
const NUM_SEGMENTS   = 30;
const CRASH_BUFFER_M = 150;

// Selected year for crash filter (default 2024 to avoid 2000-record cap on long routes)
let _selectedYear = 2024;

// Route preference: 'faster' uses OSRM default; 'safer' scores alternatives by crash density
let _routeMode = 'faster';

// Last rendered route — stored so year changes can re-render without re-geocoding
let _currentGeometry = null;
let _currentPlaces   = null;

// Crash data keyed by segKey so the sidebar can look them up from an onclick
const _segCrashStore = {};

// Sidebar filter/search state
let _activeSidebarCrashes = [];
const _activeFilters = new Set(); // active severity labels; empty = show all

// All crashes within buffer of the current route (populated after each render)
let _allRouteCrashes = [];

// ── Helpers ────────────────────────────────────────────────────────────────
function haversineM(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180, Δλ = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function distToSegmentM(plat, plon, alat, alon, blat, blon) {
    const cosLat = Math.cos(alat * Math.PI / 180);
    const px = (plon - alon) * cosLat, py = plat - alat;
    const dx = (blon - alon) * cosLat, dy = blat - alat;
    const lenSq = dx * dx + dy * dy;
    if (lenSq < 1e-20) return haversineM(plat, plon, alat, alon);
    const t = Math.max(0, Math.min(1, (px * dx + py * dy) / lenSq));
    return haversineM(plat, plon, alat + t * (blat - alat), alon + t * (blon - alon));
}

function sevColor(sev) {
    if (!sev) return '#9ca3af';
    const s = sev.toLowerCase();
    if (s.includes('fatal'))                              return '#dc2626';
    if (s.includes('incapacit') && !s.includes('non'))   return '#f97316';
    if (s.includes('non-incapacit') || s.includes('minor')) return '#eab308';
    if (s.includes('possible'))                           return '#facc15';
    if (s.includes('property') || s.includes('pdo') || s.includes('no injury')) return '#22c55e';
    return '#9ca3af';
}

function formatHour(h) {
    const n = parseInt(h);
    if (isNaN(n)) return null;
    const ampm = n < 12 ? 'AM' : 'PM';
    const h12  = n === 0 ? 12 : n > 12 ? n - 12 : n;
    return `${h12}:00 ${ampm}`;
}

function parseCrashDate(raw) {
    if (raw == null) return null;
    const d = new Date(typeof raw === 'number' ? raw : raw);
    return isNaN(d.getTime()) ? null : d;
}

// ── Crash data fetch ───────────────────────────────────────────────────────
async function fetchCrashesForYear(minLat, minLon, maxLat, maxLon, year) {
    const pad = 0.005;
    const geom = JSON.stringify({
        xmin: minLon - pad, ymin: minLat - pad,
        xmax: maxLon + pad, ymax: maxLat + pad,
        spatialReference: { wkid: 4326 },
    });
    const params = new URLSearchParams({
        where: `CrashDateYear = ${year}`,
        geometry: geom,
        geometryType: 'esriGeometryEnvelope',
        spatialRel: 'esriSpatialRelIntersects',
        outFields: 'OBJECTID,CrashDate,CrashTimeHour,DayofWeek,CrashSeverity,MostSevereInjury,CrashTownName,NameOfRoadway,NameOfIntersectingRoadway',
        returnGeometry: 'true',
        resultRecordCount: '2000',
        f: 'geojson',
    });
    const res = await fetch(`${CRASH_API}?${params}`);
    if (!res.ok) throw new Error(`Crash API ${res.status}`);
    const json = await res.json();
    return json.features ?? [];
}

async function fetchCrashesInBounds(minLat, minLon, maxLat, maxLon) {
    if (_selectedYear !== 'all') {
        return fetchCrashesForYear(minLat, minLon, maxLat, maxLon, _selectedYear);
    }
    // Fetch each year in parallel so each gets its own 2000-record budget
    const years = [2022, 2023, 2024, 2025];
    const results = await Promise.all(years.map(y => fetchCrashesForYear(minLat, minLon, maxLat, maxLon, y)));
    return results.flat();
}

// ── Segment assignment ─────────────────────────────────────────────────────
function assignCrashesToSegments(crashes, geoCoords, numSeg) {
    const numLegs = geoCoords.length - 1;
    const segments = Array.from({ length: numSeg }, () => []);
    if (numLegs < 1) return segments;

    for (const feature of crashes) {
        const [lon, lat] = feature.geometry.coordinates;
        if (!isFinite(lat) || !isFinite(lon)) continue;
        let minDist = Infinity, bestLeg = 0;
        for (let i = 0; i < numLegs; i++) {
            const [alon, alat] = geoCoords[i];
            const [blon, blat] = geoCoords[i + 1];
            const d = distToSegmentM(lat, lon, alat, alon, blat, blon);
            if (d < minDist) { minDist = d; bestLeg = i; }
        }
        if (minDist <= CRASH_BUFFER_M) {
            const si = Math.min(Math.floor(bestLeg / numLegs * numSeg), numSeg - 1);
            segments[si].push(feature);
        }
    }
    return segments;
}

// ── Color mapping ──────────────────────────────────────────────────────────
function densityToColor(count, maxCount) {
    if (maxCount === 0) return '#22c55e';
    const t = Math.min(count / maxCount, 1);
    let r, g;
    if (t < 0.5) { r = Math.round(510 * t); g = 200; }
    else { r = 255; g = Math.round(200 * (1 - (t - 0.5) * 2)); }
    return `rgb(${r},${g},0)`;
}

// ── Popup builder ──────────────────────────────────────────────────────────
function buildSegmentPopup(crashes, segKey) {
    _segCrashStore[segKey] = crashes;

    if (crashes.length === 0) {
        return `<div class="seg-popup">
            <div class="seg-popup-hdr">No Crashes · This Stretch</div>
            <p class="seg-popup-empty">No crashes recorded here (2022–present).</p>
        </div>`;
    }

    const items = crashes
        .map(f => {
            const p = f.properties ?? {};
            return { date: parseCrashDate(p.CrashDate), sev: p.CrashSeverity || p.MostSevereInjury || 'Unknown', road: p.NameOfRoadway || '', cross: p.NameOfIntersectingRoadway || '', town: p.CrashTownName || '' };
        })
        .sort((a, b) => (b.date || 0) - (a.date || 0));

    // Severity breakdown
    const sevCount = {};
    items.forEach(({ sev }) => { sevCount[sev] = (sevCount[sev] || 0) + 1; });
    const SEV_ORDER = ['Fatal', 'Incapacit', 'Non-Incapacit', 'Possible', 'Property', 'No Injury'];
    const sevRows = Object.entries(sevCount)
        .sort(([a], [b]) => {
            const ai = SEV_ORDER.findIndex(k => a.startsWith(k));
            const bi = SEV_ORDER.findIndex(k => b.startsWith(k));
            return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
        })
        .map(([sev, n]) =>
            `<tr><td><span class="sev-dot" style="background:${sevColor(sev)}"></span>${sev}</td><td class="sev-n">${n}</td></tr>`
        ).join('');

    // Up to 3 most recent
    const recentHtml = items.slice(0, 3).map(({ date, sev, road, cross, town }) => {
        const dateStr = date ? date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'Unknown date';
        const loc = road && cross ? `${road} & ${cross}` : road || cross || town || '';
        return `<li class="rec-item">
            <span class="rec-date">${dateStr}</span>
            ${loc ? `<span class="rec-loc">${loc}</span>` : ''}
            <span class="rec-sev">${sev}</span>
        </li>`;
    }).join('');

    return `<div class="seg-popup">
        <div class="seg-popup-hdr">${crashes.length} Crash${crashes.length !== 1 ? 'es' : ''} · This Stretch</div>
        <table class="sev-table"><tbody>${sevRows}</tbody></table>
        <div class="rec-label">Recent incidents</div>
        <ul class="rec-list">${recentHtml}</ul>
        <button class="popup-view-all" onclick="openCrashSidebar('${segKey}')">
            View all ${crashes.length} crash${crashes.length !== 1 ? 'es' : ''} &rarr;
        </button>
        <div class="popup-source">Source: CTSRC &middot; 2022–present</div>
    </div>`;
}

// ── Crash card (for sidebar) ───────────────────────────────────────────────
function buildCrashCard(feature) {
    const p       = feature.properties ?? {};
    const date    = parseCrashDate(p.CrashDate);
    const dateStr = date
        ? date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
        : 'Unknown date';
    const timeStr = formatHour(p.CrashTimeHour);
    const sev     = p.CrashSeverity || p.MostSevereInjury || 'Unknown severity';
    const road    = p.NameOfRoadway || '';
    const cross   = p.NameOfIntersectingRoadway || '';
    const town    = p.CrashTownName || '';
    const loc     = road && cross ? `${road} & ${cross}` : road || cross || '';
    const color   = sevColor(sev);

    return `<div class="crash-card" style="border-left-color:${color}">
        <div class="card-sev" style="color:${color}">${sev}</div>
        <div class="card-date">${dateStr}${timeStr ? ` &middot; ${timeStr}` : ''}</div>
        ${loc  ? `<div class="card-loc">${loc}</div>` : ''}
        ${town ? `<div class="card-town">${town}, CT</div>` : ''}
    </div>`;
}

// ── Sidebar search & filter ────────────────────────────────────────────────
function getCrashSev(feature) {
    const p = feature.properties ?? {};
    return p.CrashSeverity || p.MostSevereInjury || 'Unknown';
}

// Re-render the body applying current search text and active severity filters
function renderSidebarCrashes() {
    const query = (document.getElementById('sidebar-search')?.value ?? '').trim().toLowerCase();

    let filtered = _activeSidebarCrashes;

    if (_activeFilters.size > 0) {
        filtered = filtered.filter(f => _activeFilters.has(getCrashSev(f)));
    }

    if (query) {
        filtered = filtered.filter(f => {
            const p = f.properties ?? {};
            const text = [p.NameOfRoadway, p.NameOfIntersectingRoadway, p.CrashTownName]
                .filter(Boolean).join(' ').toLowerCase();
            return text.includes(query);
        });
    }

    // Sort most-recent first
    filtered = [...filtered].sort((a, b) => {
        const da = parseCrashDate((a.properties ?? {}).CrashDate);
        const db = parseCrashDate((b.properties ?? {}).CrashDate);
        return (db || 0) - (da || 0);
    });

    const body = document.getElementById('sidebar-body');
    body.innerHTML = filtered.length === 0
        ? '<p class="sidebar-empty">No crashes match your search.</p>'
        : filtered.map(buildCrashCard).join('');

    const countEl = document.getElementById('sidebar-result-count');
    if (countEl) {
        const total = _activeSidebarCrashes.length;
        countEl.textContent = filtered.length === total
            ? ''
            : `Showing ${filtered.length} of ${total} crashes`;
    }
}

// Build severity filter chips from the crashes in this segment
function buildFilterChips(crashes) {
    const sevSet = new Set(crashes.map(getCrashSev));

    // Preferred display order
    const SEV_ORDER = ['Fatal', 'Incapacit', 'Non-Incapacit', 'Possible', 'Property', 'No Injury', 'Unknown'];
    const sorted = [...sevSet].sort((a, b) => {
        const ai = SEV_ORDER.findIndex(k => a.startsWith(k));
        const bi = SEV_ORDER.findIndex(k => b.startsWith(k));
        return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    });

    const container = document.getElementById('filter-chips');
    container.innerHTML = '';

    sorted.forEach(sev => {
        const chip = document.createElement('button');
        chip.className = 'filter-chip';
        chip.type = 'button';
        chip.textContent = sev;
        chip.style.setProperty('--chip-color', sevColor(sev));

        chip.addEventListener('click', () => {
            if (_activeFilters.has(sev)) {
                _activeFilters.delete(sev);
                chip.classList.remove('active');
            } else {
                _activeFilters.add(sev);
                chip.classList.add('active');
            }
            renderSidebarCrashes();
        });

        container.appendChild(chip);
    });
}

// ── Sidebar open / close ───────────────────────────────────────────────────
window.openCrashSidebar = function (segKey) {
    const crashes = _segCrashStore[segKey] || [];
    map.closePopup();

    // Reset state
    _activeSidebarCrashes = crashes;
    _activeFilters.clear();
    const searchEl = document.getElementById('sidebar-search');
    if (searchEl) searchEl.value = '';
    const countEl = document.getElementById('sidebar-result-count');
    if (countEl) countEl.textContent = '';

    document.getElementById('sidebar-title').textContent =
        `${crashes.length} Crash${crashes.length !== 1 ? 'es' : ''} · This Stretch`;

    buildFilterChips(crashes);
    renderSidebarCrashes();

    document.getElementById('crash-sidebar').classList.add('open');
    document.getElementById('sidebar-overlay').classList.add('visible');
};

function closeSidebar() {
    document.getElementById('crash-sidebar').classList.remove('open');
    document.getElementById('sidebar-overlay').classList.remove('visible');
}

document.getElementById('sidebar-close').addEventListener('click', closeSidebar);
document.getElementById('sidebar-overlay').addEventListener('click', closeSidebar);
document.getElementById('sidebar-search').addEventListener('input', renderSidebarCrashes);

// Open sidebar with every on-route crash when the header status chip is clicked
function openAllCrashesSidebar() {
    if (!_allRouteCrashes.length) return;
    map.closePopup();

    _activeSidebarCrashes = _allRouteCrashes;
    _activeFilters.clear();

    const searchEl = document.getElementById('sidebar-search');
    if (searchEl) searchEl.value = '';
    const countEl = document.getElementById('sidebar-result-count');
    if (countEl) countEl.textContent = '';

    document.getElementById('sidebar-title').textContent =
        `All ${_allRouteCrashes.length} Route Crash${_allRouteCrashes.length !== 1 ? 'es' : ''}`;

    buildFilterChips(_allRouteCrashes);
    renderSidebarCrashes();

    document.getElementById('crash-sidebar').classList.add('open');
    document.getElementById('sidebar-overlay').classList.add('visible');
}

document.getElementById('crash-status').addEventListener('click', openAllCrashesSidebar);

// ── Legend ─────────────────────────────────────────────────────────────────
function addCrashLegend(maxCount) {
    if (legendControl) { map.removeControl(legendControl); legendControl = null; }
    legendControl = L.control({ position: 'bottomright' });
    legendControl.onAdd = () => {
        const div = L.DomUtil.create('div', 'crash-legend');
        div.innerHTML = `
            <div class="legend-title">Crash Density</div>
            <div class="legend-scale">
                <span class="legend-label">Low</span>
                <div class="legend-gradient"></div>
                <span class="legend-label">High (${maxCount})</span>
            </div>
            <div class="legend-note">${_selectedYear === 'all' ? '2022–2025' : _selectedYear} &middot; 150 m buffer</div>
        `;
        return div;
    };
    legendControl.addTo(map);
}

// ── Colored route builder ──────────────────────────────────────────────────
function buildColoredRoute(geometry, segments) {
    const coords   = geometry.coordinates;
    const numSeg   = segments.length;
    const counts   = segments.map(s => s.length);
    const maxCount = Math.max(...counts);
    const numLegs  = coords.length - 1;
    const group    = L.layerGroup();

    for (let s = 0; s < numSeg; s++) {
        const startIdx = Math.round(s * numLegs / numSeg);
        const endIdx   = Math.min(Math.round((s + 1) * numLegs / numSeg), numLegs);
        const pts      = coords.slice(startIdx, endIdx + 1).map(([lon, lat]) => [lat, lon]);
        if (pts.length < 2) continue;

        const segKey  = `seg-${s}`;
        const color   = densityToColor(counts[s], maxCount);
        const tooltip = `${counts[s]} crash${counts[s] !== 1 ? 'es' : ''} — click for details`;

        L.polyline(pts, { color, weight: 7, opacity: 0.92 })
            .bindTooltip(tooltip, { sticky: true })
            .bindPopup(buildSegmentPopup(segments[s], segKey), { maxWidth: 300, className: 'crash-popup' })
            .addTo(group);
    }
    return group;
}

// ── Render route ───────────────────────────────────────────────────────────
async function renderRoute(geometry, places) {
    _currentGeometry = geometry;
    _currentPlaces   = places;

    // Reset state from any previous route
    Object.keys(_segCrashStore).forEach(k => delete _segCrashStore[k]);
    _allRouteCrashes = [];
    closeSidebar();
    const statusEl2 = document.getElementById('crash-status');
    if (statusEl2) statusEl2.classList.remove('clickable');
    if (routeLayer) map.removeLayer(routeLayer);
    if (legendControl) { map.removeControl(legendControl); legendControl = null; }
    markerGroup.clearLayers();

    places.forEach((place, i) => {
        const isStart = i === 0, isEnd = i === places.length - 1;
        const color = isStart ? '#16a34a' : isEnd ? '#dc2626' : '#f59e0b';
        const label = isStart ? 'A' : isEnd ? 'B' : String(i);
        L.marker([place.lat, place.lon], { icon: makeIcon(color, label) })
            .bindPopup(`<b>${label}</b><br><small>${place.name.split(',').slice(0, 2).join(',')}</small>`)
            .addTo(markerGroup);
    });

    // Placeholder route while crash data loads
    routeLayer = L.geoJSON(geometry, {
        style: { color: '#94a3b8', weight: 6, opacity: 0.55, dashArray: '10,6' },
    }).addTo(map);
    map.fitBounds(routeLayer.getBounds(), { padding: [40, 40] });

    const statusEl = document.getElementById('crash-status');
    if (statusEl) statusEl.textContent = 'Loading crash data…';

    try {
        const lats = geometry.coordinates.map(c => c[1]);
        const lons = geometry.coordinates.map(c => c[0]);
        const crashes  = await fetchCrashesInBounds(
            Math.min(...lats), Math.min(...lons),
            Math.max(...lats), Math.max(...lons)
        );
        const segments = assignCrashesToSegments(crashes, geometry.coordinates, NUM_SEGMENTS);
        const counts   = segments.map(s => s.length);
        const onRoute  = counts.reduce((a, b) => a + b, 0);
        _allRouteCrashes = segments.flat();

        map.removeLayer(routeLayer);
        routeLayer = buildColoredRoute(geometry, segments).addTo(map);
        addCrashLegend(Math.max(...counts));

        if (statusEl) {
            statusEl.textContent =
                `${onRoute.toLocaleString()} crash${onRoute !== 1 ? 'es' : ''} on route`
                + ` · ${crashes.length.toLocaleString()} in area`;
            statusEl.classList.add('clickable');
        }
    } catch (err) {
        console.error('Crash data error:', err);
        map.removeLayer(routeLayer);
        routeLayer = L.geoJSON(geometry, {
            style: { color: '#1e3a8a', weight: 5, opacity: 0.8 },
        }).addTo(map);
        if (statusEl) statusEl.textContent = 'Crash data unavailable';
    }
}

// ── Autocomplete ───────────────────────────────────────────────────────────
// Photon (Komoot) is built for fast search-as-you-type on OSM data.
// Results are cached and stale requests are aborted so the UI stays snappy.

const _autocompleteCache = new Map();

const STATE_ABBR = {
    Connecticut: 'CT', 'New York': 'NY', Massachusetts: 'MA',
    'Rhode Island': 'RI', Vermont: 'VT', 'New Hampshire': 'NH',
    Maine: 'ME', 'New Jersey': 'NJ', Pennsylvania: 'PA',
};

function photonLabel(p) {
    const parts = [p.name];
    if (p.city && p.city !== p.name)     parts.push(p.city);
    else if (p.county && p.county !== p.name) parts.push(p.county);
    if (p.state) parts.push(STATE_ABBR[p.state] || p.state);
    return parts.filter(Boolean).join(', ');
}

function attachAutocomplete(input) {
    const field    = input.closest('.field');
    const dropdown = document.createElement('ul');
    dropdown.className = 'autocomplete-dropdown';
    field.appendChild(dropdown);

    let timer, highlighted = -1, controller = null;

    function closeDropdown() {
        dropdown.innerHTML = '';
        dropdown.classList.remove('visible');
        highlighted = -1;
    }

    function highlight(index) {
        const items = dropdown.querySelectorAll('li');
        items.forEach(li => li.classList.remove('highlighted'));
        highlighted = Math.max(0, Math.min(index, items.length - 1));
        if (items[highlighted]) items[highlighted].classList.add('highlighted');
    }

    input.addEventListener('input', () => {
        clearTimeout(timer);
        const val = input.value.trim();
        if (val.length < 2) { closeDropdown(); return; }

        timer = setTimeout(async () => {
            if (controller) controller.abort();
            controller = new AbortController();

            try {
                const cacheKey = val.toLowerCase();
                let features;

                if (_autocompleteCache.has(cacheKey)) {
                    features = _autocompleteCache.get(cacheKey);
                } else {
                    // bbox = lon_min,lat_min,lon_max,lat_max (CT + small border buffer)
                    const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(val)}&limit=6&bbox=-73.8,40.9,-71.7,42.1&lang=en`;
                    const res  = await fetch(url, { signal: controller.signal });
                    const json = await res.json();
                    features = (json.features ?? []).filter(f => f.properties?.countrycode === 'US');
                    _autocompleteCache.set(cacheKey, features);
                }

                dropdown.innerHTML = '';
                highlighted = -1;
                if (!features.length) { closeDropdown(); return; }

                features.forEach(feature => {
                    const label = photonLabel(feature.properties);
                    const li    = document.createElement('li');
                    li.textContent = label;
                    li.addEventListener('mousedown', e => { e.preventDefault(); input.value = label; closeDropdown(); });
                    dropdown.appendChild(li);
                });
                dropdown.classList.add('visible');
            } catch (err) {
                if (err.name !== 'AbortError') console.warn('Autocomplete error', err);
            }
        }, 150);
    });

    input.addEventListener('keydown', e => {
        const items = dropdown.querySelectorAll('li');
        if (!items.length) return;
        if      (e.key === 'ArrowDown')                  { e.preventDefault(); highlight(highlighted + 1); }
        else if (e.key === 'ArrowUp')                    { e.preventDefault(); highlight(highlighted - 1); }
        else if (e.key === 'Enter' && highlighted >= 0)  { e.preventDefault(); input.value = items[highlighted].textContent; closeDropdown(); }
        else if (e.key === 'Escape')                     { closeDropdown(); }
    });

    input.addEventListener('blur', () => setTimeout(closeDropdown, 150));
}

attachAutocomplete(document.getElementById('start-local'));
attachAutocomplete(document.getElementById('end-local'));

// ── Use current location ───────────────────────────────────────────────────
document.getElementById('btn-use-location').addEventListener('click', () => {
    if (!navigator.geolocation) {
        alert('Geolocation is not supported by your browser.');
        return;
    }
    const btn   = document.getElementById('btn-use-location');
    const input = document.getElementById('start-local');

    btn.classList.add('locating');
    btn.disabled = true;
    input.placeholder = 'Locating…';

    navigator.geolocation.getCurrentPosition(
        async ({ coords }) => {
            try {
                const { latitude: lat, longitude: lon } = coords;
                const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`;
                const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
                const data = await res.json();
                const addr = data.address || {};
                // Build a short human-readable label: house+road or just town
                const parts = [
                    addr.house_number && addr.road ? `${addr.house_number} ${addr.road}` : addr.road,
                    addr.city || addr.town || addr.village || addr.county,
                    addr.state ? (STATE_ABBR[addr.state] || addr.state) : null,
                ].filter(Boolean);
                input.value = parts.join(', ');
            } catch {
                input.value = '';
                alert('Could not look up your address. Please type it in manually.');
            } finally {
                input.placeholder = 'e.g. Hartford, CT';
                btn.classList.remove('locating');
                btn.disabled = false;
            }
        },
        (err) => {
            const msgs = {
                1: 'Location access was denied. Please allow it in your browser settings.',
                2: 'Your location could not be determined.',
                3: 'Location request timed out.',
            };
            alert(msgs[err.code] || 'Could not get your location.');
            input.placeholder = 'e.g. Hartford, CT';
            btn.classList.remove('locating');
            btn.disabled = false;
        },
        { timeout: 10000, maximumAge: 60000 }
    );
});

// ── Stop fields ────────────────────────────────────────────────────────────
let stopCount = 0;

btnAddStop.addEventListener('click', () => {
    stopCount++;
    const id      = `stop-${stopCount}`;
    const wrapper = document.createElement('div');
    wrapper.className = 'stop-field';
    wrapper.innerHTML = `
        <div class="field">
            <label for="${id}">Stop ${stopCount}</label>
            <input type="text" id="${id}" placeholder="e.g. Middletown, CT">
        </div>
        <button class="remove-stop-btn" type="button" aria-label="Remove stop">&times;</button>
    `;
    wrapper.querySelector('.remove-stop-btn').addEventListener('click', () => wrapper.remove());
    attachAutocomplete(wrapper.querySelector('input'));
    stopsContainer.appendChild(wrapper);
});

// ── Enter Route ────────────────────────────────────────────────────────────
btnEnterRoute.addEventListener('click', async () => {
    routeError.textContent = '';
    btnEnterRoute.textContent = _routeMode === 'safer' ? 'Finding safer route…' : 'Loading…';
    btnEnterRoute.disabled = true;

    try {
        const startVal = document.getElementById('start-local').value.trim();
        const endVal   = document.getElementById('end-local').value.trim();
        if (!startVal || !endVal) throw new Error('Please enter both a starting and ending location.');

        const stopInputs = stopsContainer.querySelectorAll('input[type="text"]');
        const stopVals   = Array.from(stopInputs).map(el => el.value.trim()).filter(Boolean);
        const allQueries = [startVal, ...stopVals, endVal];

        const places   = await Promise.all(allQueries.map(q => geocode(q)));
        const routes   = await getRoutes(places);
        const geometry = await pickRoute(routes);

        initMap();
        landingPage.classList.add('hidden');
        mapView.classList.remove('hidden');
        mapTitle.textContent = `${startVal} → ${endVal}`;

        setTimeout(async () => {
            map.invalidateSize();
            await renderRoute(geometry, places);
        }, 50);

    } catch (err) {
        routeError.textContent = err.message;
    } finally {
        btnEnterRoute.textContent = 'Enter Route';
        btnEnterRoute.disabled = false;
    }
});

// ── Route mode toggle ──────────────────────────────────────────────────────
document.getElementById('btn-mode-faster').addEventListener('click', () => {
    _routeMode = 'faster';
    document.getElementById('btn-mode-faster').classList.add('active');
    document.getElementById('btn-mode-safer').classList.remove('active');
});

document.getElementById('btn-mode-safer').addEventListener('click', () => {
    _routeMode = 'safer';
    document.getElementById('btn-mode-safer').classList.add('active');
    document.getElementById('btn-mode-faster').classList.remove('active');
});

// ── Year filter ────────────────────────────────────────────────────────────
document.getElementById('year-btns').addEventListener('click', async e => {
    const btn = e.target.closest('.year-btn');
    if (!btn || !_currentGeometry) return;

    const year = btn.dataset.year === 'all' ? 'all' : parseInt(btn.dataset.year);
    if (year === _selectedYear) return;

    _selectedYear = year;
    document.querySelectorAll('.year-btn').forEach(b => b.classList.toggle('active', b === btn));

    await renderRoute(_currentGeometry, _currentPlaces);
});

// ── Back button ────────────────────────────────────────────────────────────
btnBack.addEventListener('click', () => {
    closeSidebar();
    mapView.classList.add('hidden');
    landingPage.classList.remove('hidden');
    if (legendControl) { map.removeControl(legendControl); legendControl = null; }
    const statusEl = document.getElementById('crash-status');
    if (statusEl) statusEl.textContent = '';

    // Reset filters to defaults for next route
    _selectedYear = 2024;
    _routeMode = 'faster';
    document.getElementById('btn-mode-faster').classList.add('active');
    document.getElementById('btn-mode-safer').classList.remove('active');
    _currentGeometry = null;
    _currentPlaces   = null;
    document.querySelectorAll('.year-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.year === '2024');
    });
});
