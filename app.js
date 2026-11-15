/* Nisselunden – bevægelsessensor der starter musik.
   Skrevet i gammeldags JavaScript (ES5) med vilje, så den også kører på ældre telefoner. */
(function () {
  'use strict';

  // --- Faste værdier -------------------------------------------------------
  var B = 80, H = 60;            // analyseopløsning
  var KOL = 8, RAEK = 6;         // felter i gitteret
  var TAKT_MS = 200;             // tid mellem målinger
  var PIXEL_FORSKEL = 24;        // hvor meget en pixel skal ændre sig (0-255)
  var HOLD_MAALINGER = 3;        // bevægelsen skal vare så mange målinger i træk
  var BAGGRUND_TILPASNING = 0.05;
  var LYSSKIFT_PROCENT = 70;     // ændres mere end dette på én gang, er det lyset og ikke en person
  var MOERKE_GRAENSE = 18;       // gennemsnitlig lysstyrke hvorunder sensoren holder pause
  var KAMERA_STILLE_MS = 10000;  // så længe må kameraet stå stille før genstart
  var SLUK_EFTER_MS = 120000;
  var MUSIKFIL = 'musik.mp3';

  // --- Elementer -----------------------------------------------------------
  function el(id) { return document.getElementById(id); }
  var video = el('video'), vaagenVideo = el('vaagen');
  var laerred = document.createElement('canvas');
  laerred.width = B; laerred.height = H;
  var ctx = laerred.getContext('2d', { willReadFrequently: true }) || laerred.getContext('2d');

  // --- Indstillinger -------------------------------------------------------
  var inds = { taerskel: 4, pause: 20, kamera: 'environment', felter: null };
  function hent(noegle) {
    try { return JSON.parse(localStorage.getItem(noegle)); } catch (e) { return null; }
  }
  function gem(noegle, vaerdi) {
    try { localStorage.setItem(noegle, JSON.stringify(vaerdi)); } catch (e) {}
  }
  (function () {
    var g = hent('nisse-inds'), k;
    if (g) { for (k in inds) { if (g[k] !== undefined && g[k] !== null) { inds[k] = g[k]; } } }
    if (!inds.felter || inds.felter.length !== KOL * RAEK) {
      inds.felter = [];
      for (k = 0; k < KOL * RAEK; k++) { inds.felter.push(1); }
    }
  })();
  function gemInds() { gem('nisse-inds', inds); }

  // --- Log -----------------------------------------------------------------
  var log = hent('nisse-log') || [];
  function to(n) { return (n < 10 ? '0' : '') + n; }
  function klokken(d) { return to(d.getHours()) + ':' + to(d.getMinutes()) + ':' + to(d.getSeconds()); }
  function skrivLog(tekst) {
    var d = new Date();
    log.push(to(d.getDate()) + '/' + to(d.getMonth() + 1) + ' ' + klokken(d) + '  ' + tekst);
    if (log.length > 150) { log = log.slice(log.length - 150); }
    gem('nisse-log', log);
    visLog();
  }
  function visLog() { el('log').textContent = log.slice().reverse().join('\n'); }

  // --- Tilstand ------------------------------------------------------------
  var tilstand = 'venter';       // venter | klar | spiller | pause | moerkt | fejl
  var startet = 0, antal = 0, genstarter = 0, seneste = null;
  var pauseSlut = 0, spilStart = 0;
  var baggrund = null, graa = new Float32Array(B * H), pixelFelt = new Uint8Array(B * H);
  var feltTael = [], feltStr = [], aktivePixels = 0;
  var traef = 0, niveau = 0;
  var stream = null, kameraStarter = false;
  var sidsteVideoTid = -1, sidsteVideoSkift = 0;
  var sidsteBeroering = 0, slukket = false;

  (function () {
    var x, y;
    for (y = 0; y < H; y++) {
      for (x = 0; x < B; x++) {
        pixelFelt[y * B + x] = Math.floor(y * RAEK / H) * KOL + Math.floor(x * KOL / B);
      }
    }
    for (x = 0; x < KOL * RAEK; x++) { feltTael.push(0); feltStr.push(0); }
    for (x = 0; x < B * H; x++) { feltStr[pixelFelt[x]]++; }
  })();
  function taelAktive() {
    var i; aktivePixels = 0;
    for (i = 0; i < KOL * RAEK; i++) { if (inds.felter[i]) { aktivePixels += feltStr[i]; } }
  }
  taelAktive();

  // --- Musik ---------------------------------------------------------------
  // Hentes som én blok og afspilles fra hukommelsen, så den virker uden net
  // og ikke skal hentes igen ved hver udløsning.
  var lyd = new Audio();
  lyd.preload = 'auto';
  var musikKlar = false;

  function hentMusik(faerdig) {
    var x = new XMLHttpRequest();
    x.open('GET', MUSIKFIL, true);
    x.responseType = 'blob';
    x.onload = function () {
      if (x.status >= 200 && x.status < 300 && x.response && window.URL && URL.createObjectURL) {
        lyd.src = URL.createObjectURL(x.response);
      } else {
        lyd.src = MUSIKFIL;
      }
      faerdig();
    };
    x.onerror = function () { lyd.src = MUSIKFIL; faerdig(); };
    x.send();
  }

  lyd.addEventListener('ended', function () { musikSlut('færdig'); });
  lyd.addEventListener('error', function () {
    if (tilstand === 'spiller') { skrivLog('Fejl i musikafspilning'); musikSlut('fejl'); }
  });

  function spil(aarsag) {
    tilstand = 'spiller';
    spilStart = Date.now();
    try { lyd.currentTime = 0; } catch (e) {}
    var p;
    try { p = lyd.play(); } catch (e2) { skrivLog('Kunne ikke starte musik: ' + e2.message); musikSlut('fejl'); return; }
    if (p && p.then) {
      p.then(null, function (fejl) {
        skrivLog('Kunne ikke starte musik: ' + (fejl && fejl.name));
        musikSlut('fejl');
      });
    }
    if (aarsag === 'bevægelse') {
      antal++; seneste = new Date();
      skrivLog('Udløst (' + niveau.toFixed(1) + ' %)');
    }
  }
  function musikSlut() {
    if (tilstand !== 'spiller') { return; }
    try { lyd.pause(); } catch (e) {}
    tilstand = 'pause';
    pauseSlut = Date.now() + inds.pause * 1000;
    traef = 0;
  }

  // --- Kamera --------------------------------------------------------------
  function stopKamera() {
    if (stream) {
      try {
        var spor = stream.getTracks(), i;
        for (i = 0; i < spor.length; i++) { spor[i].stop(); }
      } catch (e) {}
    }
    stream = null;
  }
  function startKamera() {
    if (kameraStarter) { return; }
    kameraStarter = true;
    stopKamera();
    baggrund = null; traef = 0;
    var md = navigator.mediaDevices;
    if (!md || !md.getUserMedia) {
      kameraStarter = false;
      tilstand = 'fejl';
      fejlTekst = 'Browseren giver ikke adgang til kameraet. Prøv en nyere browser, og tjek at adressen starter med https.';
      return;
    }
    md.getUserMedia({
      audio: false,
      video: { facingMode: inds.kamera, width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 10 } }
    }).then(function (s) {
      kameraStarter = false;
      stream = s;
      video.srcObject = s;
      var p = video.play();
      if (p && p.then) { p.then(null, function () {}); }
      sidsteVideoSkift = Date.now(); sidsteVideoTid = -1;
      if (tilstand === 'venter' || tilstand === 'fejl') { tilstand = 'klar'; }
    }, function (fejl) {
      kameraStarter = false;
      sidsteVideoSkift = Date.now();   // prøv igen om lidt via vagthunden
      if (tilstand !== 'spiller' && tilstand !== 'pause') { tilstand = 'fejl'; }
      fejlTekst = (fejl && fejl.name === 'NotAllowedError')
        ? 'Siden har ikke fået lov til at bruge kameraet. Giv tilladelse i browserens indstillinger.'
        : 'Kameraet kunne ikke startes (' + (fejl && fejl.name) + '). Prøver igen.';
      skrivLog('Kamerafejl: ' + (fejl && fejl.name));
    });
  }
  var fejlTekst = '';

  video.addEventListener('loadedmetadata', function () {
    if (video.videoWidth) {
      el('billede').style.paddingBottom = (video.videoHeight / video.videoWidth * 100) + '%';
    }
  });

  // --- Måling --------------------------------------------------------------
  function maal() {
    if (!stream || video.readyState < 2 || !video.videoWidth) { return; }
    var data;
    try {
      ctx.drawImage(video, 0, 0, B, H);
      data = ctx.getImageData(0, 0, B, H).data;
    } catch (e) { return; }

    var n = B * H, i, j, sum = 0, sumBg = 0;
    for (i = 0, j = 0; i < n; i++, j += 4) {
      graa[i] = (data[j] * 3 + data[j + 1] * 6 + data[j + 2]) / 10;
    }
    if (!baggrund) { baggrund = new Float32Array(graa); return; }

    for (i = 0; i < n; i++) {
      if (inds.felter[pixelFelt[i]]) { sum += graa[i]; sumBg += baggrund[i]; }
    }
    if (!aktivePixels) { niveau = 0; return; }
    var lys = sum / aktivePixels;
    var forskydning = lys - sumBg / aktivePixels;   // udligner skyer og kameraets lysjustering

    var aendret = 0, f, d;
    for (i = 0; i < KOL * RAEK; i++) { feltTael[i] = 0; }
    for (i = 0; i < n; i++) {
      f = pixelFelt[i];
      if (!inds.felter[f]) { continue; }
      d = graa[i] - baggrund[i] - forskydning;
      if (d > PIXEL_FORSKEL || d < -PIXEL_FORSKEL) { aendret++; feltTael[f]++; }
    }
    niveau = aendret / aktivePixels * 100;

    var lysskift = niveau > LYSSKIFT_PROCENT;
    var a = lysskift ? 0.5 : BAGGRUND_TILPASNING;
    for (i = 0; i < n; i++) { baggrund[i] += (graa[i] - baggrund[i]) * a; }

    var moerkt = lys < MOERKE_GRAENSE;
    if (tilstand === 'klar' && moerkt) { tilstand = 'moerkt'; skrivLog('For mørkt, sensoren holder pause'); }
    else if (tilstand === 'moerkt' && lys > MOERKE_GRAENSE + 6) { tilstand = 'klar'; traef = 0; skrivLog('Lyst nok igen'); }

    if (!lysskift && niveau >= inds.taerskel) { traef++; } else { traef = 0; }
    if (tilstand === 'klar' && traef >= HOLD_MAALINGER) { spil('bevægelse'); }
  }

  // --- Vagthund ------------------------------------------------------------
  function vagthund() {
    var nu = Date.now();
    if (tilstand === 'pause' && nu >= pauseSlut) { tilstand = 'klar'; traef = 0; }
    if (tilstand === 'spiller') {
      var laengde = (lyd.duration && isFinite(lyd.duration)) ? lyd.duration : 300;
      if (nu - spilStart > (laengde + 15) * 1000) { skrivLog('Musikken hang, nulstillet'); musikSlut('hang'); }
    }
    if (document.hidden) { sidsteVideoSkift = nu; return; }
    if (video.currentTime !== sidsteVideoTid) {
      sidsteVideoTid = video.currentTime; sidsteVideoSkift = nu;
    } else if (nu - sidsteVideoSkift > KAMERA_STILLE_MS && !kameraStarter) {
      genstarter++;
      skrivLog('Kameraet stod stille, genstarter');
      sidsteVideoSkift = nu;
      startKamera();
    }
    if (!slukket && nu - sidsteBeroering > SLUK_EFTER_MS) { sluk(true); }
  }

  // --- Hold skærmen vågen --------------------------------------------------
  var vaagenLaas = null, vaagenMaade = '–';
  function holdVaagen() {
    if (navigator.wakeLock && navigator.wakeLock.request) {
      navigator.wakeLock.request('screen').then(function (l) {
        vaagenLaas = l; vaagenMaade = 'skærmlås (wake lock)';
        l.addEventListener('release', function () { vaagenLaas = null; });
      }, function () { vaagenVideoStart(); });
    } else {
      vaagenVideoStart();
    }
  }
  function vaagenVideoStart() {
    vaagenMaade = 'skjult video';
    var p;
    try { p = vaagenVideo.play(); } catch (e) { vaagenMaade = 'ingen – slå skærmlås fra'; return; }
    if (p && p.then) { p.then(null, function () { vaagenMaade = 'ingen – slå skærmlås fra'; }); }
  }
  document.addEventListener('visibilitychange', function () {
    if (!startet || document.hidden) { return; }
    if (!vaagenLaas) { holdVaagen(); }
    var p = video.play();
    if (p && p.then) { p.then(null, function () {}); }
  });

  // --- Visning -------------------------------------------------------------
  var felter = [];
  (function () {
    var g = el('gitter'), i, d;
    for (i = 0; i < KOL * RAEK; i++) {
      d = document.createElement('div');
      d.setAttribute('data-i', i);
      g.appendChild(d);
      felter.push(d);
    }
    g.addEventListener('click', function (e) {
      var i = e.target.getAttribute && e.target.getAttribute('data-i');
      if (i === null || i === undefined) { return; }
      i = +i;
      inds.felter[i] = inds.felter[i] ? 0 : 1;
      taelAktive(); gemInds(); baggrund = null;
    });
  })();

  function varighed(ms) {
    var m = Math.floor(ms / 60000), t = Math.floor(m / 60);
    return t ? t + ' t ' + (m % 60) + ' min' : m + ' min';
  }
  var TEKSTER = {
    venter: 'Starter kamera …',
    klar: 'Klar – venter på bevægelse',
    spiller: 'Spiller musik',
    moerkt: 'For mørkt – sensoren holder pause'
  };
  function vis() {
    var nu = Date.now(), tekst;
    if (tilstand === 'pause') { tekst = 'Pause – klar igen om ' + Math.max(0, Math.ceil((pauseSlut - nu) / 1000)) + ' sek.'; }
    else if (tilstand === 'fejl') { tekst = fejlTekst; }
    else { tekst = TEKSTER[tilstand]; }

    if (slukket) {
      el('sluktekst').textContent = 'Nisselunden kører · ' + antal + ' udløsninger · ' + tekst + ' · tryk for at se mere';
      return;
    }
    var s = el('status');
    s.textContent = tekst; s.className = tilstand;

    var skala = 30, i;
    el('niveau').style.width = Math.min(100, niveau / skala * 100) + '%';
    el('niveau').className = niveau >= inds.taerskel ? 'over' : '';
    el('graense').style.left = Math.min(100, inds.taerskel / skala * 100) + '%';
    el('niveautal').textContent = niveau.toFixed(1);
    for (i = 0; i < felter.length; i++) {
      felter[i].className = !inds.felter[i] ? 'fra' : (feltTael[i] > feltStr[i] * 0.2 ? 'varm' : '');
    }
    el('oppetid').textContent = varighed(nu - startet);
    el('antal').textContent = antal;
    el('seneste').textContent = seneste ? klokken(seneste) : '–';
    el('genstarter').textContent = genstarter;
    el('vaagenmaade').textContent = vaagenMaade;
  }

  function sluk(til) {
    slukket = til;
    el('sluk').hidden = !til;
    if (!til) { sidsteBeroering = Date.now(); }
    vis();
  }
  function beroering() { sidsteBeroering = Date.now(); }
  document.addEventListener('touchstart', beroering, true);
  document.addEventListener('mousedown', beroering, true);
  el('sluk').addEventListener('click', function () { sluk(false); });
  el('slukknap').addEventListener('click', function (e) { e.stopPropagation(); sluk(true); });

  // --- Betjening -----------------------------------------------------------
  function visSkydere() {
    el('taerskel').value = inds.taerskel; el('taerskeltal').textContent = inds.taerskel;
    el('pause').value = inds.pause; el('pausetal').textContent = inds.pause;
  }
  el('taerskel').addEventListener('input', function () { inds.taerskel = +this.value; visSkydere(); gemInds(); });
  el('pause').addEventListener('input', function () { inds.pause = +this.value; visSkydere(); gemInds(); });
  el('testknap').addEventListener('click', function () {
    if (tilstand === 'spiller') { musikSlut('stoppet'); } else { spil('test'); }
  });
  el('kameraknap').addEventListener('click', function () {
    inds.kamera = inds.kamera === 'environment' ? 'user' : 'environment';
    gemInds(); startKamera();
  });
  el('rydlog').addEventListener('click', function () { log = []; gem('nisse-log', log); visLog(); });

  // --- Start ---------------------------------------------------------------
  var startknap = el('startknap');
  startknap.addEventListener('click', function () {
    if (startet) { return; }
    startet = Date.now(); sidsteBeroering = startet;

    // Lås lyden op mens vi har brugerens tryk: spil lydløst et øjeblik.
    lyd.muted = true;
    var p;
    try { p = lyd.play(); } catch (e) {}
    var efter = function () {
      try { lyd.pause(); lyd.currentTime = 0; } catch (e) {}
      lyd.muted = false;
    };
    if (p && p.then) { p.then(efter, efter); } else { setTimeout(efter, 100); }

    holdVaagen();
    el('forside').hidden = true;
    el('drift').hidden = false;
    visSkydere(); visLog();
    skrivLog('Startet');
    startKamera();
    setInterval(maal, TAKT_MS);
    setInterval(vagthund, 1000);
    setInterval(vis, 250);
  });

  hentMusik(function () {
    musikKlar = true;
    startknap.disabled = false;
    startknap.textContent = 'Start';
  });

  if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
    el('fejl').textContent = 'Siden skal åbnes med https, ellers må den ikke bruge kameraet.';
  }

  // --- Virker uden internet -----------------------------------------------
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then(function () {
      return navigator.serviceWorker.ready;
    }).then(function () {
      el('offline').textContent = 'ja';
    }, function () { el('offline').textContent = 'nej'; });
  } else {
    el('offline').textContent = 'nej (browseren kan ikke)';
  }
})();
