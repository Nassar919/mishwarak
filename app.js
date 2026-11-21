/* مشوارك - خريطة وحساب سعر المشوار (OpenStreetMap + Nominatim + OSRM - بدون مفاتيح أو فواتير) */
(function (root) {
  'use strict';

  var CONFIG = {
    BASE_FARE_EGP: 20,
    PER_KM_EGP: 18,
    WAIT_FIRST_HOUR_EGP: 30,
    WAIT_EXTRA_HOUR_EGP: 20,
    ROUND_TO_EGP: 1,
    FORM_RESPONSE_URL: 'https://docs.google.com/forms/d/e/1FAIpQLScF8U2pSggUHdxd_KtVRA2rar1PAqgvImeWfqJHmpX8W4TFEA/formResponse',
    FORM_VIEW_URL: 'https://docs.google.com/forms/d/e/1FAIpQLScF8U2pSggUHdxd_KtVRA2rar1PAqgvImeWfqJHmpX8W4TFEA/viewform',
    ENTRY: {
      name: 'entry.1564057719',
      phone: 'entry.1712955507',
      pickup: 'entry.1011937626',
      destination: 'entry.643188171',
      date: 'entry.1535974678',
      time: 'entry.1460420301',
      passengers: 'entry.631978374'
    },
    WHATSAPP_NUMBER: '201021454736',
    EGYPT_CENTER: [26.8206, 30.8025],
    EGYPT_ZOOM: 6,
    NOMINATIM: 'https://nominatim.openstreetmap.org',
    OSRM: 'https://router.project-osrm.org',
    TILES: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    SEARCH_DEBOUNCE_MS: 450,
    SEARCH_MIN_CHARS: 3
  };

  /* ---------- pure logic (unit-testable) ---------- */

  function computeFare(distanceKm, cfg) {
    cfg = cfg || CONFIG;
    if (!(distanceKm > 0)) return null;
    var raw = cfg.BASE_FARE_EGP + cfg.PER_KM_EGP * distanceKm;
    var r = cfg.ROUND_TO_EGP || 1;
    return Math.round(raw / r) * r;
  }

  // waiting: first hour 30 EGP, each extra hour 20 EGP. Any part of an hour counts as a full hour.
  function computeWait(hours, cfg) {
    cfg = cfg || CONFIG;
    var h = Math.ceil(Number(hours) || 0);
    if (h <= 0) return 0;
    return cfg.WAIT_FIRST_HOUR_EGP + (h - 1) * cfg.WAIT_EXTRA_HOUR_EGP;
  }

  function waitLabel(hours) {
    var h = Math.ceil(Number(hours) || 0);
    if (h <= 0) return 'بدون انتظار';
    if (h === 1) return 'ساعة انتظار';
    if (h === 2) return 'ساعتين انتظار';
    return h + ' ساعات انتظار';
  }

  function splitDate(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    return m ? { year: m[1], month: m[2], day: m[3] } : null;
  }

  function splitTime(hm) {
    var m = /^(\d{2}):(\d{2})$/.exec(hm || '');
    return m ? { hour: m[1], minute: m[2] } : null;
  }

  function buildFormBody(data, cfg) {
    cfg = cfg || CONFIG;
    var p = {};
    p[cfg.ENTRY.name] = data.name;
    p[cfg.ENTRY.phone] = data.phone;
    p[cfg.ENTRY.pickup] = data.pickupText;
    p[cfg.ENTRY.destination] = data.destinationText;
    var d = splitDate(data.dateISO);
    if (d) {
      p[cfg.ENTRY.date + '_year'] = d.year;
      p[cfg.ENTRY.date + '_month'] = d.month;
      p[cfg.ENTRY.date + '_day'] = d.day;
    }
    var t = splitTime(data.timeHM);
    if (t) {
      p[cfg.ENTRY.time + '_hour'] = t.hour;
      p[cfg.ENTRY.time + '_minute'] = t.minute;
    }
    p[cfg.ENTRY.passengers] = data.passengers;
    return p;
  }

  function buildPrefillUrl(data, cfg) {
    cfg = cfg || CONFIG;
    var qs = ['usp=pp_url'];
    function add(k, v) { if (v != null && v !== '') qs.push(encodeURIComponent(k) + '=' + encodeURIComponent(v)); }
    add(cfg.ENTRY.name, data.name);
    add(cfg.ENTRY.phone, data.phone);
    add(cfg.ENTRY.pickup, data.pickupText);
    add(cfg.ENTRY.destination, data.destinationText);
    if (splitDate(data.dateISO)) add(cfg.ENTRY.date, data.dateISO);
    if (splitTime(data.timeHM)) add(cfg.ENTRY.time, data.timeHM);
    add(cfg.ENTRY.passengers, data.passengers);
    return cfg.FORM_VIEW_URL + '?' + qs.join('&');
  }

  function buildWhatsAppUrl(data, cfg) {
    cfg = cfg || CONFIG;
    var lines = [
      'طلب مشوار جديد من موقع مشوارك',
      'الاسم: ' + data.name,
      'مكان التحرك: ' + data.pickupText,
      'الوجهة: ' + data.destinationText,
      'المسافة التقريبية: ' + data.distanceKm + ' كم',
      'السعر التقريبي: ' + data.fareEgp + ' جنيه'
    ];
    if (data.waitHours > 0) lines.push('الانتظار: ' + waitLabel(data.waitHours) + ' (' + data.waitEgp + ' جنيه)');
    if (data.dateISO) lines.push('التاريخ: ' + data.dateISO);
    if (data.timeHM) lines.push('الوقت: ' + data.timeHM);
    if (data.passengers) lines.push('عدد الركاب: ' + data.passengers);
    return 'https://wa.me/' + cfg.WHATSAPP_NUMBER + '?text=' + encodeURIComponent(lines.join('\n'));
  }

  function estimateNote() {
    return 'السعر ده تقريبي على حسب المسافة على الخريطة ومدة الانتظار. السعر النهائي بيتأكد معاك بالتليفون قبل المشوار.';
  }

  function formatDuration(seconds) {
    var h = Math.floor(seconds / 3600), m = Math.round((seconds % 3600) / 60);
    if (h <= 0) return m + ' دقيقة';
    if (m === 0) return h + ' ساعة';
    return h + ' ساعة و ' + m + ' دقيقة';
  }

  var logic = {
    CONFIG: CONFIG,
    computeFare: computeFare,
    computeWait: computeWait,
    waitLabel: waitLabel,
    buildFormBody: buildFormBody,
    buildPrefillUrl: buildPrefillUrl,
    buildWhatsAppUrl: buildWhatsAppUrl,
    estimateNote: estimateNote,
    formatDuration: formatDuration
  };

  if (typeof module !== 'undefined' && module.exports) { module.exports = logic; return; }
  root.Mishwarak = logic;

  /* ---------- UI wiring (browser only, needs Leaflet as window.L) ---------- */

  var state = { pickup: null, destination: null, routeKm: null, durationText: null, fare: null, waitHours: 0 };
  var map, routeLine, pickupMarker, destMarker;
  var clickTarget = 'pickup';
  var searchTimers = {};

  function $(id) { return document.getElementById(id); }

  function makeIcon(which) {
    return L.divIcon({
      className: 'mk-wrap',
      html: '<div class="mk mk-' + which + '">' + (which === 'pickup' ? 'أ' : 'ب') + '</div>',
      iconSize: [34, 34], iconAnchor: [17, 17]
    });
  }

  function initMap() {
    map = L.map('map', { zoomControl: true }).setView(CONFIG.EGYPT_CENTER, CONFIG.EGYPT_ZOOM);
    L.tileLayer(CONFIG.TILES, {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(map);

    map.on('click', function (e) {
      setPoint(clickTarget, [e.latlng.lat, e.latlng.lng], null);
      reverseGeocode(e.latlng.lat, e.latlng.lng, clickTarget);
      clickTarget = (clickTarget === 'pickup') ? 'destination' : 'pickup';
      updateClickHint();
    });

    setupSearch('pickup-input', 'pickup-suggest', 'pickup');
    setupSearch('destination-input', 'destination-suggest', 'destination');

    $('myloc-btn').addEventListener('click', useMyLocation);
    $('swap-btn').addEventListener('click', swapPoints);
    $('clear-btn').addEventListener('click', clearAll);
    $('wait-select').addEventListener('change', function () {
      state.waitHours = parseInt($('wait-select').value, 10) || 0;
      if (state.routeKm) renderResult();
    });
    wireRequestForm();
    updateClickHint();
  }

  /* ----- Nominatim search with debounce + cache (usage-policy friendly) ----- */

  var searchCache = {};

  function nominatimSearch(q, cb) {
    var key = q.trim().toLowerCase();
    if (searchCache[key]) return cb(null, searchCache[key]);
    var url = CONFIG.NOMINATIM + '/search?format=jsonv2&countrycodes=eg&accept-language=ar&limit=6&q=' + encodeURIComponent(q);
    fetch(url, { headers: { 'Accept': 'application/json' } })
      .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
      .then(function (arr) { searchCache[key] = arr; cb(null, arr); })
      .catch(function (err) { cb(err); });
  }

  function reverseGeocode(lat, lng, which) {
    var url = CONFIG.NOMINATIM + '/reverse?format=jsonv2&accept-language=ar&zoom=16&lat=' + lat + '&lon=' + lng;
    fetch(url, { headers: { 'Accept': 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (res) {
        if (!res || !res.display_name) return;
        var label = res.display_name;
        var st = which === 'pickup' ? state.pickup : state.destination;
        if (st) st.label = label;
        $(which === 'pickup' ? 'pickup-input' : 'destination-input').value = label;
      })
      .catch(function () {});
  }

  function setupSearch(inputId, listId, which) {
    var input = $(inputId), list = $(listId);

    function close() { list.classList.add('hidden'); list.innerHTML = ''; }

    input.addEventListener('input', function () {
      clearTimeout(searchTimers[which]);
      var q = input.value;
      if (!q || q.trim().length < CONFIG.SEARCH_MIN_CHARS) { close(); return; }
      searchTimers[which] = setTimeout(function () {
        nominatimSearch(q, function (err, results) {
          if (err || !results || !results.length) { close(); return; }
          list.innerHTML = '';
          results.forEach(function (res) {
            var li = document.createElement('li');
            li.textContent = res.display_name;
            li.addEventListener('click', function () {
              input.value = res.display_name;
              close();
              setPoint(which, [parseFloat(res.lat), parseFloat(res.lon)], res.display_name);
              map.setView([parseFloat(res.lat), parseFloat(res.lon)], 14);
            });
            list.appendChild(li);
          });
          list.classList.remove('hidden');
        });
      }, CONFIG.SEARCH_DEBOUNCE_MS);
    });

    document.addEventListener('click', function (e) {
      if (e.target !== input && !list.contains(e.target)) close();
    });
  }

  function setPoint(which, latLng, label) {
    var marker = which === 'pickup' ? pickupMarker : destMarker;
    if (marker) map.removeLayer(marker);
    marker = L.marker(latLng, { draggable: true, icon: makeIcon(which) }).addTo(map);
    marker.on('dragend', function () {
      var p = marker.getLatLng();
      setPoint(which, [p.lat, p.lng], null);
      reverseGeocode(p.lat, p.lng, which);
    });
    if (which === 'pickup') { pickupMarker = marker; state.pickup = { latLng: latLng, label: label }; }
    else { destMarker = marker; state.destination = { latLng: latLng, label: label }; }
    if (label) $(which === 'pickup' ? 'pickup-input' : 'destination-input').value = label;
    maybeRoute();
  }

  function swapPoints() {
    var p = state.pickup, d = state.destination;
    var pv = $('pickup-input').value, dv = $('destination-input').value;
    clearMarkers();
    state.pickup = null; state.destination = null;
    $('pickup-input').value = dv; $('destination-input').value = pv;
    if (d) setPoint('pickup', d.latLng, dv);
    if (p) setPoint('destination', p.latLng, pv);
  }

  function clearMarkers() {
    if (pickupMarker) { map.removeLayer(pickupMarker); pickupMarker = null; }
    if (destMarker) { map.removeLayer(destMarker); destMarker = null; }
    if (routeLine) { map.removeLayer(routeLine); routeLine = null; }
    state.routeKm = null; state.fare = null;
    $('result-card').classList.add('hidden');
  }

  function clearAll() {
    clearMarkers();
    state.pickup = null; state.destination = null;
    $('pickup-input').value = ''; $('destination-input').value = '';
    clickTarget = 'pickup';
    updateClickHint();
    map.setView(CONFIG.EGYPT_CENTER, CONFIG.EGYPT_ZOOM);
  }

  function useMyLocation() {
    if (!navigator.geolocation) return;
    $('myloc-btn').disabled = true;
    navigator.geolocation.getCurrentPosition(function (pos) {
      $('myloc-btn').disabled = false;
      var ll = [pos.coords.latitude, pos.coords.longitude];
      setPoint('pickup', ll, null);
      reverseGeocode(ll[0], ll[1], 'pickup');
      map.setView(ll, 14);
    }, function () { $('myloc-btn').disabled = false; }, { timeout: 10000 });
  }

  function updateClickHint() {
    $('click-hint').textContent = clickTarget === 'pickup'
      ? 'تقدر تدوس على أي مكان على الخريطة يتحدد كمكان التحرك، وبعدها دوس على الوجهة.'
      : 'دلوقتي دوس على الوجهة على الخريطة.';
  }

  /* ----- OSRM driving route ----- */

  function maybeRoute() {
    if (!state.pickup || !state.destination) return;
    $('result-card').classList.add('hidden');
    $('route-error').classList.add('hidden');
    var a = state.pickup.latLng, b = state.destination.latLng;
    var url = CONFIG.OSRM + '/route/v1/driving/' + a[1] + ',' + a[0] + ';' + b[1] + ',' + b[0] +
      '?overview=full&geometries=geojson';
    fetch(url)
      .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
      .then(function (res) {
        if (!res || res.code !== 'Ok' || !res.routes || !res.routes.length) throw new Error('no route');
        var route = res.routes[0];
        state.routeKm = route.distance / 1000;
        state.durationText = formatDuration(route.duration);
        state.fare = computeFare(state.routeKm);
        if (routeLine) map.removeLayer(routeLine);
        var latlngs = route.geometry.coordinates.map(function (c) { return [c[1], c[0]]; });
        routeLine = L.polyline(latlngs, { color: '#0e8a7d', weight: 5, opacity: 0.8 }).addTo(map);
        map.fitBounds(routeLine.getBounds(), { padding: [30, 30] });
        renderResult();
      })
      .catch(function () {
        $('route-error').textContent = 'مش لاقيين طريق بالعربية بين النقطتين دول. جرب نقط تانية أو كلمنا واتساب.';
        $('route-error').classList.remove('hidden');
      });
  }

  function renderResult() {
    $('distance-val').textContent = state.routeKm.toFixed(1) + ' كم';
    $('duration-val').textContent = state.durationText;
    var w = computeWait(state.waitHours);
    $('fare-val').textContent = (state.fare + w) + ' جنيه';
    $('fare-breakdown').textContent = 'المشوار ' + state.fare + ' جنيه' + (w ? ' + ' + waitLabel(state.waitHours) + ' ' + w + ' جنيه' : '');
    $('fare-note').textContent = estimateNote();
    $('result-card').classList.remove('hidden');
    $('request-card').classList.remove('hidden');
  }

  function collectRequest() {
    return {
      name: $('req-name').value.trim(),
      phone: $('req-phone').value.trim(),
      dateISO: $('req-date').value,
      timeHM: $('req-time').value,
      passengers: $('req-passengers').value,
      pickupText: $('pickup-input').value.trim(),
      destinationText: $('destination-input').value.trim(),
      distanceKm: state.routeKm ? state.routeKm.toFixed(1) : '',
      fareEgp: state.fare ? (state.fare + computeWait(state.waitHours)) : '',
      waitHours: state.waitHours,
      waitEgp: computeWait(state.waitHours)
    };
  }

  function validate(data) {
    var errs = [];
    if (!data.name) errs.push('اكتب اسمك');
    if (!/^01[0-9]{9}$/.test(data.phone.replace(/[\s-]/g, ''))) errs.push('اكتب رقم موبايل مصري صحيح (11 رقم يبدأ بـ 01)');
    if (!data.pickupText) errs.push('حدد مكان التحرك');
    if (!data.destinationText) errs.push('حدد الوجهة');
    if (!data.dateISO) errs.push('اختار تاريخ المشوار');
    if (!data.timeHM) errs.push('اختار وقت التحرك');
    if (!data.passengers) errs.push('اختار عدد الركاب');
    return errs;
  }

  function wireRequestForm() {
    $('req-form').addEventListener('submit', function (ev) {
      ev.preventDefault();
      var data = collectRequest();
      var errs = validate(data);
      if (errs.length) {
        $('form-errors').innerHTML = errs.map(function (e) { return '<div>• ' + e + '</div>'; }).join('');
        $('form-errors').classList.remove('hidden');
        return;
      }
      $('form-errors').classList.add('hidden');
      submitToGoogleForm(data);
      showSuccess(data);
    });
  }

  function submitToGoogleForm(data) {
    // destination carries the estimate so it reaches the owner in the same response
    data.destinationText = data.destinationText +
      (data.distanceKm ? ' | المسافة: حوالي ' + data.distanceKm + ' كم' : '') +
      (data.waitHours > 0 ? ' | الانتظار: ' + waitLabel(data.waitHours) + ' (' + data.waitEgp + ' جنيه)' : '') +
      (data.fareEgp ? ' | السعر التقريبي الكلي المعروض للعميل: ' + data.fareEgp + ' جنيه' : '');
    var body = buildFormBody(data);
    var form = document.createElement('form');
    form.method = 'POST';
    form.action = CONFIG.FORM_RESPONSE_URL;
    form.target = 'hidden-submit-frame';
    form.style.display = 'none';
    Object.keys(body).forEach(function (k) {
      var inp = document.createElement('input');
      inp.name = k; inp.value = body[k];
      form.appendChild(inp);
    });
    document.body.appendChild(form);
    form.submit();
    setTimeout(function () { form.remove(); }, 5000);
  }

  function showSuccess(data) {
    $('wa-link').href = buildWhatsAppUrl(data);
    $('prefill-link').href = buildPrefillUrl(data);
    $('success-card').classList.remove('hidden');
    $('success-card').scrollIntoView({ behavior: 'smooth' });
  }

  document.addEventListener('DOMContentLoaded', function () {
    if (typeof L === 'undefined') {
      $('map').innerHTML = '<div class="map-missing">حصلت مشكلة في تحميل الخريطة. جرب تعمل تحديث للصفحة.</div>';
      $('request-card').classList.remove('hidden');
      wireRequestForm();
      return;
    }
    initMap();
  });
})(typeof window !== 'undefined' ? window : this);
