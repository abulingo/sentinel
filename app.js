// ========================================================
// LIFEGUARD SENTINEL - LÓGICA PRINCIPAL DEL CLIENTE
// ========================================================

// Configuración Supabase fija
const SUPABASE_URL = "https://oxzhmeeyiesflhhhehpa.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im94emhtZWV5aWVzZmxoaGhlaHBhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg3MzQyMjEsImV4cCI6MjEwNDMxMDIyMX0.iwAwe-sylkP8HYQ8OhH4TRMveaX4GjVMEArxkItsosE";

// URL de tu Worker en Render (dejar como fallback si se desea disparo inmediato HTTP)
const RENDER_BRIDGE_URL = "https://render-u18c.onrender.com";

let supabaseClient = null;

function getSupabase() {
  if (supabaseClient) return supabaseClient;
  
  // Buscar en los diferentes objetos globales expuestos por el bundle UMD / CDN
  const factory = window.supabase?.createClient 
               || window.supabasejs?.createClient 
               || (typeof createClient === 'function' ? createClient : null);

  if (factory) {
    try {
      supabaseClient = factory(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
          storage: window.localStorage
        }
      });
      return supabaseClient;
    } catch (e) {
      console.error("Error al instanciar Supabase:", e);
    }
  }
  return null;
}

// Estados en memoria
let currentUser = null;
let currentProfile = {
  first_name: '',
  telegram_phone: '',
  telegram_session: '',
  telegram_api_id: '',
  telegram_api_hash: '',
  pin_duress: '9999',
  pin_cancel: '0000'
};
let contacts = [];
let selectedDuration = 0; // en segundos
let timerInterval = null;
let timeRemaining = 0;
let timerExpiresAt = null; // Timestamp UNIX exacto de vencimiento
let currentPinInput = '';
let currentGps = { latitude: null, longitude: null, accuracy: null };
let audioCtx = null;
let isAudioActive = false;

// Elementos DOM
const screens = {
  login: document.getElementById('screenLogin'),
  register: document.getElementById('screenRegister'),
  contacts: document.getElementById('screenContacts'),
  selectTimer: document.getElementById('screenSelectTimer'),
  timerActive: document.getElementById('screenTimerActive')
};

function showScreen(screenKey) {
  Object.values(screens).forEach(screen => screen.classList.remove('active'));
  screens[screenKey].classList.add('active');
}

// ----------------------------------------------------
// 1. SISTEMA DE AUDIO, KEEP-ALIVE Y VIBRACIÓN (SEGUNDO PLANO Y ALERTAS)
// ----------------------------------------------------
let warningSoundInterval = null;
let isWarningActive = false;
let bgKeepAliveAudio = null;
let bgWorker = null;

function initAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
}

// Generador de audio silencioso en formato WAV PCM para mantener despierta la app en segundo plano
function getSilentAudioBlobUrl() {
  const sampleRate = 8000;
  const numSamples = sampleRate * 1; // 1 segundo
  const buffer = new Uint8Array(44 + numSamples);
  // RIFF
  buffer[0] = 0x52; buffer[1] = 0x49; buffer[2] = 0x46; buffer[3] = 0x46;
  const totalSize = 36 + numSamples;
  buffer[4] = totalSize & 0xff; buffer[5] = (totalSize >> 8) & 0xff;
  buffer[6] = (totalSize >> 16) & 0xff; buffer[7] = (totalSize >> 24) & 0xff;
  // WAVE
  buffer[8] = 0x57; buffer[9] = 0x41; buffer[10] = 0x56; buffer[11] = 0x45;
  // fmt
  buffer[12] = 0x66; buffer[13] = 0x6d; buffer[14] = 0x74; buffer[15] = 0x20;
  buffer[16] = 16; buffer[17] = 0; buffer[18] = 0; buffer[19] = 0;
  buffer[20] = 1; buffer[21] = 0; // PCM
  buffer[22] = 1; buffer[23] = 0; // Mono
  buffer[24] = sampleRate & 0xff; buffer[25] = (sampleRate >> 8) & 0xff; buffer[26] = 0; buffer[27] = 0;
  buffer[28] = sampleRate & 0xff; buffer[29] = (sampleRate >> 8) & 0xff; buffer[30] = 0; buffer[31] = 0;
  buffer[32] = 1; buffer[33] = 0;
  buffer[34] = 8; buffer[35] = 0;
  // data
  buffer[36] = 0x64; buffer[37] = 0x61; buffer[38] = 0x74; buffer[39] = 0x61;
  buffer[40] = numSamples & 0xff; buffer[41] = (numSamples >> 8) & 0xff;
  buffer[42] = (numSamples >> 16) & 0xff; buffer[43] = (numSamples >> 24) & 0xff;
  for (let i = 0; i < numSamples; i++) {
    buffer[44 + i] = 128; // silencio en 8-bit PCM
  }
  const blob = new Blob([buffer], { type: 'audio/wav' });
  return URL.createObjectURL(blob);
}

// Inicia reproducción de audio silencioso y MediaSession para evitar suspensión del navegador al salir a Drive / WhatsApp
function startKeepAliveAudio() {
  try {
    if (!bgKeepAliveAudio) {
      bgKeepAliveAudio = document.getElementById('bgKeepAliveAudio');
      if (!bgKeepAliveAudio) {
        bgKeepAliveAudio = new Audio();
        bgKeepAliveAudio.id = 'bgKeepAliveAudio';
        bgKeepAliveAudio.loop = true;
        bgKeepAliveAudio.setAttribute('playsinline', '');
      }
      bgKeepAliveAudio.src = getSilentAudioBlobUrl();
      bgKeepAliveAudio.volume = 0.05;
    }

    if ('mediaSession' in navigator) {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: 'SENTINEL: Monitoreo Activo',
          artist: 'Guardia de Hombre Muerto',
          album: 'Alerta Temprana 20s Activa',
          artwork: [{ src: 'icon.svg', sizes: '512x512', type: 'image/svg+xml' }]
        });
        navigator.mediaSession.setActionHandler('play', () => {
          if (bgKeepAliveAudio) bgKeepAliveAudio.play().catch(() => {});
        });
        navigator.mediaSession.setActionHandler('pause', () => {
          if (bgKeepAliveAudio) bgKeepAliveAudio.play().catch(() => {});
        });
      } catch (e) {}
    }

    bgKeepAliveAudio.play().catch(e => {
      console.log('[Audio Keeper Notice]:', e.message);
    });
  } catch (err) {
    console.warn('[Audio Keeper Error]:', err);
  }
}

function stopKeepAliveAudio() {
  if (bgKeepAliveAudio) {
    try {
      bgKeepAliveAudio.pause();
      bgKeepAliveAudio.currentTime = 0;
    } catch (e) {}
  }
}

// Web Worker para temporización y GPS sin throttle en pestañas en segundo plano
function initBackgroundWorker() {
  if (bgWorker) return;
  try {
    const workerScript = `
      var tickInterval = null;
      var gpsInterval = null;
      self.onmessage = function(e) {
        if (e.data === 'start') {
          if (!tickInterval) {
            tickInterval = setInterval(function() {
              self.postMessage('TICK');
            }, 1000);
          }
          if (!gpsInterval) {
            gpsInterval = setInterval(function() {
              self.postMessage('GPS');
            }, 10000); // 10 segundos continuos
          }
        } else if (e.data === 'stop') {
          if (tickInterval) clearInterval(tickInterval);
          if (gpsInterval) clearInterval(gpsInterval);
          tickInterval = null;
          gpsInterval = null;
        }
      };
    `;
    const blob = new Blob([workerScript], { type: 'application/javascript' });
    bgWorker = new Worker(URL.createObjectURL(blob));
    bgWorker.onmessage = function(e) {
      if (e.data === 'TICK') {
        if (timerExpiresAt && timerInterval) {
          checkTimerStatus();
        }
      } else if (e.data === 'GPS') {
        syncGpsLocation();
      }
    };
  } catch (err) {
    console.warn('[WebWorker Error]:', err);
  }
}

function startBackgroundWorker() {
  initBackgroundWorker();
  if (bgWorker) {
    bgWorker.postMessage('start');
  }
}

function stopBackgroundWorker() {
  if (bgWorker) {
    bgWorker.postMessage('stop');
  }
}

// Sonido penetrante y distintivo para Alerta Temprana (20 segundos antes del vencimiento)
function playWarningTone() {
  try {
    initAudio();
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
    const now = audioCtx.currentTime;

    // Primer pulso agudo penetrante
    const osc1 = audioCtx.createOscillator();
    const gain1 = audioCtx.createGain();
    osc1.type = 'sawtooth';
    osc1.frequency.setValueAtTime(950, now);
    osc1.frequency.exponentialRampToValueAtTime(1750, now + 0.12);
    gain1.gain.setValueAtTime(0.75, now);
    gain1.gain.exponentialRampToValueAtTime(0.01, now + 0.14);
    osc1.connect(gain1);
    gain1.connect(audioCtx.destination);
    osc1.start(now);
    osc1.stop(now + 0.14);

    // Segundo pulso 150ms después
    const osc2 = audioCtx.createOscillator();
    const gain2 = audioCtx.createGain();
    osc2.type = 'sawtooth';
    osc2.frequency.setValueAtTime(1250, now + 0.16);
    osc2.frequency.exponentialRampToValueAtTime(2000, now + 0.28);
    gain2.gain.setValueAtTime(0.75, now + 0.16);
    gain2.gain.exponentialRampToValueAtTime(0.01, now + 0.30);
    osc2.connect(gain2);
    gain2.connect(audioCtx.destination);
    osc2.start(now + 0.16);
    osc2.stop(now + 0.30);
  } catch (err) {
    console.error("Audio warning error:", err);
  }

  // Patrón de vibración urgente
  if (navigator.vibrate) {
    navigator.vibrate([200, 80, 200]);
  }
}

function startWarningTone() {
  if (warningSoundInterval) return;
  playWarningTone();
  warningSoundInterval = setInterval(() => {
    playWarningTone();
  }, 1000); // Repetir cada segundo durante los 20 segundos
}

function stopWarningTone() {
  if (warningSoundInterval) {
    clearInterval(warningSoundInterval);
    warningSoundInterval = null;
  }
  isWarningActive = false;
}

// Tono suave armónico de confirmación al reiniciar cronómetro con PIN
function playConfirmationChime() {
  try {
    initAudio();
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
    const now = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(523.25, now); // Do5
    osc.frequency.setValueAtTime(659.25, now + 0.12); // Mi5
    osc.frequency.setValueAtTime(783.99, now + 0.24); // Sol5

    gain.gain.setValueAtTime(0.4, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.45);

    osc.connect(gain);
    gain.connect(audioCtx.destination);

    osc.start(now);
    osc.stop(now + 0.45);
  } catch (e) {
    console.warn("Chime error:", e);
  }
}

// SIRENA DE ALARMA CONTINUA Y POTENTE (Al vencerse el cronómetro a 0)
let sirenInterval = null;

function playAlarmSiren() {
  try {
    initAudio();
    if (!audioCtx) return;

    if (sirenInterval) return; // Ya está sonando

    const ringSirenPulse = () => {
      try {
        if (audioCtx.state === 'suspended') {
          audioCtx.resume();
        }
        const now = audioCtx.currentTime;
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();

        osc.type = 'sawtooth';
        // Barrido estridente de sirena de emergencia (850Hz a 1700Hz)
        osc.frequency.setValueAtTime(850, now);
        osc.frequency.linearRampToValueAtTime(1700, now + 0.25);
        osc.frequency.linearRampToValueAtTime(850, now + 0.5);

        gain.gain.setValueAtTime(0.85, now);
        gain.gain.setValueAtTime(0.85, now + 0.45);
        gain.gain.linearRampToValueAtTime(0.01, now + 0.5);

        osc.connect(gain);
        gain.connect(audioCtx.destination);

        osc.start(now);
        osc.stop(now + 0.5);

        if (navigator.vibrate) {
          navigator.vibrate([400, 100, 400, 100, 400]);
        }
      } catch (err) {
        console.warn('[Siren Pulse Error]:', err);
      }
    };

    ringSirenPulse();
    sirenInterval = setInterval(ringSirenPulse, 550);
  } catch (e) {
    console.warn('[Alarm Audio Exception]:', e);
  }
}

function stopAlarmSiren() {
  if (sirenInterval) {
    clearInterval(sirenInterval);
    sirenInterval = null;
  }
  if (navigator.vibrate) {
    navigator.vibrate(0);
  }
}

// Notificación de advertencia 20 segundos antes del vencimiento
function sendWarningNotification(secondsLeft) {
  const title = `⚠️ ¡SENTINEL: FALTAN ${secondsLeft} SEGUNDOS!`;
  const options = {
    body: 'El cronómetro de seguridad está por vencerse. Ingresa tu PIN en la app para reiniciarlo y evitar la alarma.',
    icon: 'icon.svg',
    badge: 'icon.svg',
    tag: 'sentinel-warning-20s',
    renotify: true,
    requireInteraction: true,
    vibrate: [500, 150, 500, 150, 500]
  };

  if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({
      type: 'SHOW_NOTIFICATION',
      title: title,
      options: options
    });
  } else if ('Notification' in window && Notification.permission === 'granted') {
    try {
      const notif = new Notification(title, options);
      notif.onclick = () => {
        window.focus();
        notif.close();
      };
    } catch (e) {
      console.warn('[Notification Warning Error]:', e);
    }
  }
}

function closeWarningNotification() {
  if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({
      type: 'CLOSE_NOTIFICATION',
      tag: 'sentinel-warning-20s'
    });
  }
}

function notifyTimerExpired() {
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      const notif = new Notification('🚨 ¡SENTINEL: ALERTA ACTIVADA! 🚨', {
        body: 'El cronómetro de seguridad ha vencido sin respuesta. Se han despachado llamadas y mensajes de auxilio con tu ubicación.',
        icon: 'icon.svg',
        badge: 'icon.svg',
        requireInteraction: true,
        vibrate: [500, 200, 500, 200, 1000]
      });
      notif.onclick = () => {
        window.focus();
        notif.close();
      };
    } catch (e) {
      console.warn('[Notification Error]:', e);
    }
  }
}

// ----------------------------------------------------
// 2. GEOLOCALIZACIÓN CONSTANTE Y ENVÍO CADA 10 SEGUNDOS A SUPABASE
// ----------------------------------------------------
let gpsIntervalId = null;
let lastGpsSyncTime = null;
let lastGpsSentTimestamp = 0;
let isGpsSyncing = false;
let wakeLockSentinel = null;

async function requestWakeLock() {
  if ('wakeLock' in navigator) {
    try {
      wakeLockSentinel = await navigator.wakeLock.request('screen');
      console.log('[WakeLock] Pantalla bloqueada contra suspensión durante monitoreo.');
    } catch (err) {
      console.warn('[WakeLock Error]:', err.message);
    }
  }
}

function releaseWakeLock() {
  if (wakeLockSentinel) {
    try {
      wakeLockSentinel.release();
    } catch (e) {}
    wakeLockSentinel = null;
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
    if (timerExpiresAt && timerInterval) {
      checkTimerStatus();
    }
    if (timerInterval && !wakeLockSentinel) {
      requestWakeLock();
    }
  }
});

window.addEventListener('focus', () => {
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
  if (timerExpiresAt && timerInterval) {
    checkTimerStatus();
  }
});

// Sincronización continua de ubicación a Supabase cada 10 segundos
function syncGpsLocation() {
  const now = Date.now();
  // Evitar disparos redundantes si pasaron menos de 7 segundos
  if (now - lastGpsSentTimestamp < 7000 || isGpsSyncing) {
    return;
  }

  if (!currentUser) return;

  if ('geolocation' in navigator) {
    isGpsSyncing = true;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        isGpsSyncing = false;
        lastGpsSentTimestamp = Date.now();
        updateGpsCoords(pos);
        updateLocationInSupabase();
      },
      (err) => {
        isGpsSyncing = false;
        // Si demora o falla el GPS satelital, enviar la última posición válida en memoria
        if (currentGps.latitude !== null && currentGps.longitude !== null) {
          lastGpsSentTimestamp = Date.now();
          updateLocationInSupabase();
        }
      },
      { enableHighAccuracy: true, timeout: 5000, maximumAge: 10000 }
    );
  } else if (currentGps.latitude !== null && currentGps.longitude !== null) {
    lastGpsSentTimestamp = Date.now();
    updateLocationInSupabase();
  }
}

function initGeolocation() {
  if ('geolocation' in navigator) {
    // 1. Obtener primera posición inmediata con alta precisión
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        updateGpsCoords(pos);
        if (currentUser) {
          updateLocationInSupabase();
        }
      },
      (err) => console.warn('[GPS Inicial Warning]:', err.message),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
    );

    // 2. Escuchar cambios de coordenadas por movimiento continuo
    navigator.geolocation.watchPosition(
      (pos) => {
        updateGpsCoords(pos);
      },
      (err) => console.warn('[GPS Watch Warning]:', err.message),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 5000 }
    );

    // 3. Envío constante cada 10 segundos a Supabase
    if (!gpsIntervalId) {
      gpsIntervalId = setInterval(() => {
        syncGpsLocation();
      }, 10000); // 10 segundos exactos
    }
  } else {
    console.warn('Geolocalización no soportada en este navegador.');
    const gpsEl = document.getElementById('gpsStatus');
    if (gpsEl) gpsEl.textContent = 'GPS: No disponible';
  }
}

function updateGpsCoords(pos) {
  currentGps.latitude = pos.coords.latitude;
  currentGps.longitude = pos.coords.longitude;
  currentGps.accuracy = pos.coords.accuracy;

  const accText = `GPS: ±${Math.round(pos.coords.accuracy)}m`;
  const gpsEl = document.getElementById('gpsStatus');
  if (gpsEl) gpsEl.textContent = accText;

  const timerGpsEl = document.getElementById('activeTimerGpsStatus');
  if (timerGpsEl) {
    const syncText = lastGpsSyncTime
      ? ` • Sync: ${lastGpsSyncTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
      : '';
    timerGpsEl.textContent = `Monitoreo Activo - ${accText}${syncText}`;
  }
}

async function updateLocationInSupabase() {
  const client = getSupabase();
  if (!client || !currentUser) return;
  if (currentGps.latitude === null || currentGps.longitude === null) return;

  try {
    const { error } = await client
      .from('active_timers')
      .update({
        last_latitude: currentGps.latitude,
        last_longitude: currentGps.longitude,
        last_accuracy: currentGps.accuracy,
        location_updated_at: new Date().toISOString()
      })
      .eq('user_id', currentUser.id);

    if (error) {
      console.warn('[GPS Sync Supabase Error]:', error.message);
    } else {
      lastGpsSyncTime = new Date();
      console.log(`📍 [GPS 10s Sync] Ubicación enviada a Supabase: ${currentGps.latitude.toFixed(5)}, ${currentGps.longitude.toFixed(5)} (±${Math.round(currentGps.accuracy)}m) a las ${lastGpsSyncTime.toLocaleTimeString()}`);
      
      const timerGpsEl = document.getElementById('activeTimerGpsStatus');
      if (timerGpsEl) {
        timerGpsEl.textContent = `Monitoreo Activo - GPS: ±${Math.round(currentGps.accuracy)}m • Sync: ${lastGpsSyncTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
      }
    }
  } catch (e) {
    console.warn('[GPS Exception]:', e);
  }
}

// ----------------------------------------------------
// 3. NAVEGACIÓN Y AUTENTICACIÓN (LOGIN / REGISTRO)
// ----------------------------------------------------
document.getElementById('btnGoToRegister').addEventListener('click', () => {
  showScreen('register');
});

document.getElementById('btnBackToLogin').addEventListener('click', () => {
  showScreen('login');
});

// INICIAR SESIÓN (Consulta Supabase auth y profiles)
document.getElementById('btnLogin').addEventListener('click', async () => {
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;

  if (!email || !password) {
    alert('Ingresa correo electrónico y contraseña.');
    return;
  }

  const client = getSupabase();
  if (!client || !client.auth) {
    alert('Error de conexión con Supabase.');
    return;
  }

  try {
    const { data, error } = await client.auth.signInWithPassword({
      email: email,
      password: password
    });

    if (error) {
      alert('Error al iniciar sesión: ' + error.message);
      return;
    }

    if (data && data.user) {
      currentUser = data.user;
      
      // Cargar perfil desde la base de datos de Supabase
      const { data: profileData, error: profileErr } = await client
        .from('profiles')
        .select('*')
        .eq('id', currentUser.id)
        .single();

      if (profileData) {
        currentProfile = profileData;
      }

      document.getElementById('userBadge').textContent = currentProfile.first_name || currentUser.email.split('@')[0];
      
      // Cargar contactos directamente desde Supabase
      await loadContactsFromSupabase();
      if (contacts.length > 0) {
        showScreen('selectTimer');
      } else {
        showScreen('contacts');
      }
    }
  } catch (err) {
    alert('Error al autenticar: ' + err.message);
  }
});

// REGISTRO DE NUEVA CUENTA
document.getElementById('btnRegister').addEventListener('click', async () => {
  const email = document.getElementById('regEmail').value.trim();
  const password = document.getElementById('regPassword').value;
  const firstName = document.getElementById('regFirstName').value.trim();
  const phone = document.getElementById('regPhone').value.trim();
  const apiId = document.getElementById('regApiId').value.trim();
  const apiHash = document.getElementById('regApiHash').value.trim();
  const session = document.getElementById('regSession').value.trim();
  const pDuress = document.getElementById('pinDuress').value.trim();
  const pCancel = document.getElementById('pinCancel').value.trim();

  if (!email || !password) {
    alert('Por favor ingresa tu correo electrónico y una contraseña (mínimo 6 caracteres).');
    return;
  }

  if (password.length < 6) {
    alert('La contraseña debe tener al menos 6 caracteres.');
    return;
  }

  if (!firstName || !phone || !session) {
    alert('Por favor ingresa nombre, teléfono y string session de Telegram.');
    return;
  }

  if (!apiId || !apiHash) {
    alert('Por favor ingresa tu Telegram API ID y API Hash (obtenidos en my.telegram.org) para llamadas y mensajes desde tu cuenta.');
    return;
  }

  if (pDuress.length !== 4 || pCancel.length !== 4) {
    alert('Los 2 códigos PIN deben tener exactamente 4 dígitos cada uno.');
    return;
  }

  if (pDuress === pCancel) {
    alert('Los 2 códigos PIN deben ser diferentes entre sí.');
    return;
  }

  const client = getSupabase();
  if (!client || !client.auth) {
    alert('Error de conexión con Supabase.');
    return;
  }

  try {
    const { data: signUpData, error: signUpError } = await client.auth.signUp({
      email: email,
      password: password,
      options: {
        data: { first_name: firstName, phone: phone }
      }
    });

    if (signUpError) {
      alert('Error al registrar usuario: ' + signUpError.message);
      return;
    }

    if (signUpData && signUpData.user) {
      currentUser = signUpData.user;
    } else {
      // Intentar login directo si el usuario ya existía
      const { data: loginData } = await client.auth.signInWithPassword({ email, password });
      if (loginData?.user) currentUser = loginData.user;
    }

    if (!currentUser) {
      alert('No se pudo establecer la sesión. Revisa los datos.');
      return;
    }

    currentProfile = {
      id: currentUser.id,
      first_name: firstName,
      telegram_phone: phone,
      telegram_api_id: apiId,
      telegram_api_hash: apiHash,
      telegram_session: session,
      pin_reset: '',
      pin_duress: pDuress,
      pin_cancel: pCancel
    };

    // Guardar en la tabla profiles de Supabase
    const { error: profileError } = await client.from('profiles').upsert({
      id: currentUser.id,
      first_name: firstName,
      telegram_phone: phone,
      telegram_api_id: apiId,
      telegram_api_hash: apiHash,
      telegram_session: session,
      pin_reset: '',
      pin_duress: pDuress,
      pin_cancel: pCancel,
      updated_at: new Date().toISOString()
    });

    if (profileError) {
      console.error('Error al guardar perfil en Supabase:', profileError);
    }

    document.getElementById('userBadge').textContent = firstName;
    await loadContactsFromSupabase();
    showScreen('contacts');
  } catch (err) {
    alert('Error en el registro: ' + err.message);
  }
});

// CERRAR SESIÓN (Limpia memoria y vuelve a Login)
document.getElementById('btnLogout').addEventListener('click', async () => {
  stopWarningTone();
  stopAlarmSiren();
  stopKeepAliveAudio();
  stopBackgroundWorker();
  closeWarningNotification();
  releaseWakeLock();
  clearInterval(timerInterval);
  timerInterval = null;
  timerExpiresAt = null;

  const client = getSupabase();
  if (client && client.auth) {
    await client.auth.signOut();
  }
  currentUser = null;
  contacts = [];
  renderContacts();
  document.getElementById('userBadge').textContent = 'Desconectado';
  showScreen('login');
});

// ----------------------------------------------------
// 5. CONTACTOS DE EMERGENCIA (GUARDADO DIRECTO EN SUPABASE)
// ----------------------------------------------------
const contactsListEl = document.getElementById('contactsList');

async function loadContactsFromSupabase() {
  contacts = [];
  const client = getSupabase();
  if (client && currentUser) {
    try {
      const { data, error } = await client
        .from('emergency_contacts')
        .select('*')
        .eq('user_id', currentUser.id)
        .order('priority_order', { ascending: true })
        .limit(5);

      if (error) {
        console.error('Error cargando emergency_contacts:', error);
      } else if (data) {
        contacts = data.map(item => ({
          id: item.id,
          name: item.name,
          phone: item.phone_number
        }));
      }
    } catch (e) {
      console.error('Error al conectar con emergency_contacts:', e);
    }
  }
  renderContacts();
}

function renderContacts() {
  contactsListEl.innerHTML = '';
  contacts.forEach((c, idx) => {
    const li = document.createElement('li');
    li.className = 'contact-item';
    li.innerHTML = `
      <div>
        <strong>${c.name}</strong>
        <p style="font-size:0.8rem; color:var(--text-muted);">${c.phone}</p>
      </div>
      <button class="contact-delete" data-idx="${idx}" data-id="${c.id || ''}">&times;</button>
    `;
    contactsListEl.appendChild(li);
  });

  document.querySelectorAll('.contact-delete').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const idx = e.target.getAttribute('data-idx');
      const contactId = e.target.getAttribute('data-id');
      const client = getSupabase();

      if (client && contactId) {
        await client.from('emergency_contacts').delete().eq('id', contactId);
      }

      contacts.splice(idx, 1);
      renderContacts();
    });
  });
}

document.getElementById('btnAddContact').addEventListener('click', async () => {
  if (contacts.length >= 5) {
    alert('El límite máximo es de 5 contactos de emergencia.');
    return;
  }

  const name = document.getElementById('contactName').value.trim();
  const phone = document.getElementById('contactPhone').value.trim();

  if (!name || !phone) {
    alert('Ingresa el nombre y teléfono del contacto (ej: +573155370380).');
    return;
  }

  if (!currentUser) {
    alert('Por favor inicia sesión primero.');
    return;
  }

  const client = getSupabase();
  let newContact = { name, phone };

  // Guardar inmediatamente en la tabla emergency_contacts de Supabase
  if (client) {
    try {
      const { data, error } = await client
        .from('emergency_contacts')
        .insert({
          user_id: currentUser.id,
          name: name,
          phone_number: phone,
          priority_order: contacts.length + 1
        })
        .select()
        .single();

      if (error) {
        alert('Error al guardar contacto en Supabase: ' + error.message);
        console.error('Error insert emergency_contacts:', error);
        return;
      }

      if (data) {
        newContact.id = data.id;
      }
    } catch (dbErr) {
      alert('Error de red al guardar contacto: ' + dbErr.message);
      return;
    }
  }

  contacts.push(newContact);
  document.getElementById('contactName').value = '';
  document.getElementById('contactPhone').value = '';
  renderContacts();
});

document.getElementById('btnGoToTimerSelect').addEventListener('click', () => {
  if (contacts.length === 0) {
    alert('Recomendado: Agrega al menos 1 contacto de emergencia antes de activar.');
  }
  showScreen('selectTimer');
});

document.getElementById('btnManageContacts').addEventListener('click', () => {
  showScreen('contacts');
});

// ----------------------------------------------------
// 6. SELECCIÓN DE TIEMPO DEL CRONÓMETRO
// ----------------------------------------------------
const timeButtons = document.querySelectorAll('.time-btn');
const btnStartWatch = document.getElementById('btnStartWatch');

timeButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    timeButtons.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    selectedDuration = parseInt(btn.getAttribute('data-seconds'), 10);
    btnStartWatch.removeAttribute('disabled');
  });
});

btnStartWatch.addEventListener('click', () => {
  if (!selectedDuration) return;
  startTimer(selectedDuration);
});

// ----------------------------------------------------
// 7. EJECUCIÓN DEL CRONÓMETRO Y ADVERTENCIA
// ----------------------------------------------------
function formatTime(totalSec) {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

const timerDisplay = document.getElementById('timerDisplay');
const timerContainer = document.getElementById('timerContainer');
const timerStatusLabel = document.getElementById('timerStatusLabel');

let isExitMode = false;
let exitModeTimeout = null;
let noticeTimeout = null;

function formatDurationLabel(seconds) {
  if (seconds >= 3600) return `${Math.round(seconds / 3600)} h`;
  if (seconds >= 60) return `${Math.round(seconds / 60)} min`;
  return `${seconds} s`;
}

function showNotice(msg, type = 'info') {
  const noticeEl = document.getElementById('timerNotice');
  if (!noticeEl) return;
  noticeEl.textContent = msg;
  noticeEl.className = `timer-notice ${type}`;
  noticeEl.style.display = 'block';

  if (noticeTimeout) clearTimeout(noticeTimeout);
  noticeTimeout = setTimeout(() => {
    noticeEl.style.display = 'none';
  }, 3500);
}

function getWarningThreshold(duration) {
  if (duration <= 20) {
    return Math.floor(duration / 2); // Para prueba de 10s -> 5s
  }
  return 20; // Exactamente 20 segundos antes para 5min, 15min, 30min y 1h
}

async function startTimer(durationSeconds) {
  selectedDuration = durationSeconds;
  timeRemaining = durationSeconds;
  timerExpiresAt = Date.now() + durationSeconds * 1000;
  clearPinInput();
  isExitMode = false;
  isWarningActive = false;
  stopWarningTone();
  stopAlarmSiren();
  closeWarningNotification();
  timerContainer.classList.remove('warning-mode', 'danger-mode');
  showScreen('timerActive');

  // Solicitar permiso de notificaciones para alertar si el usuario cambia de app
  if ('Notification' in window && Notification.permission === 'default') {
    try {
      Notification.requestPermission();
    } catch (e) {}
  }

  // Activar audio context con el click del usuario
  initAudio();
  // Iniciar audio en bucle silencioso para mantener activa la pestaña al salir a Drive o WhatsApp
  startKeepAliveAudio();
  // Iniciar Web Worker independiente para evitar suspensión de intervalos
  startBackgroundWorker();
  // Bloquear suspensión de pantalla si está en primer plano
  requestWakeLock();

  // Enviar ubicación inmediata a Supabase
  syncGpsLocation();

  // Registrar inicio en Supabase con fecha de vencimiento absoluta
  const client = getSupabase();
  if (client && currentUser) {
    const expiresAtIso = new Date(timerExpiresAt).toISOString();
    try {
      const { error: timerErr } = await client
        .from('active_timers')
        .upsert({
          user_id: currentUser.id,
          duration_seconds: durationSeconds,
          started_at: new Date().toISOString(),
          expires_at: expiresAtIso,
          status: 'running',
          alert_triggered: false,
          last_latitude: currentGps.latitude,
          last_longitude: currentGps.longitude,
          last_accuracy: currentGps.accuracy,
          location_updated_at: new Date().toISOString()
        }, { onConflict: 'user_id' });

      if (timerErr) {
        console.error('❌ Error registrando timer en Supabase:', timerErr.message);
      } else {
        console.log(`✅ Timer registrado en Supabase. Vence exactamente a las: ${expiresAtIso}`);
      }
    } catch (dbErr) {
      console.error('❌ Error conexión Supabase active_timers:', dbErr);
    }
  }

  clearInterval(timerInterval);
  updateTimerUI();

  timerInterval = setInterval(() => {
    checkTimerStatus();
  }, 1000);
}

function updateTimerUI() {
  timerDisplay.textContent = formatTime(timeRemaining);
}

function checkTimerStatus() {
  if (!timerExpiresAt) return;

  const now = Date.now();
  timeRemaining = Math.max(0, Math.round((timerExpiresAt - now) / 1000));
  updateTimerUI();

  const warningThreshold = getWarningThreshold(selectedDuration);

  // UMBRAL DE ADVERTENCIA (Exactamente 20 segundos antes para 5m, 15m, 30m, 1h):
  if (timeRemaining <= warningThreshold && timeRemaining > 0) {
    if (!isWarningActive) {
      isWarningActive = true;
      sendWarningNotification(timeRemaining);
      startWarningTone();
    }
    timerContainer.classList.add('warning-mode');
    timerStatusLabel.textContent = `¡ATENCIÓN: QUEDAN ${timeRemaining}s! INGRESA PIN`;
  } else if (timeRemaining > warningThreshold) {
    if (isWarningActive) {
      stopWarningTone();
      closeWarningNotification();
    }
    timerContainer.classList.remove('warning-mode');
    if (!isExitMode && timerStatusLabel.textContent.includes('ATENCIÓN')) {
      timerStatusLabel.textContent = 'RESTANTE';
    }
  }

  if (timeRemaining <= 0) {
    stopWarningTone();
    closeWarningNotification();
    clearInterval(timerInterval);
    timerInterval = null;
    timerExpiresAt = null;
    updateTimerUI();
    triggerAlert('timer_expired');
  }
}

function resumeRunningTimer(remainingSeconds, totalDuration) {
  selectedDuration = totalDuration || remainingSeconds;
  timeRemaining = remainingSeconds;
  timerExpiresAt = Date.now() + remainingSeconds * 1000;
  clearPinInput();
  isExitMode = false;
  isWarningActive = false;
  showScreen('timerActive');

  initAudio();
  startKeepAliveAudio();
  startBackgroundWorker();
  requestWakeLock();
  clearInterval(timerInterval);
  updateTimerUI();

  timerInterval = setInterval(() => {
    checkTimerStatus();
  }, 1000);
}

// ----------------------------------------------------
// 8. TECLADO NUMÉRICO Y LÓGICA DE LOS PINS DE 4 DÍGITOS
// ----------------------------------------------------
const pinDots = [
  document.getElementById('dot0'),
  document.getElementById('dot1'),
  document.getElementById('dot2'),
  document.getElementById('dot3')
];

function updatePinDots() {
  pinDots.forEach((dot, idx) => {
    if (idx < currentPinInput.length) {
      dot.classList.add('filled');
    } else {
      dot.classList.remove('filled');
    }
  });
}

function clearPinInput() {
  currentPinInput = '';
  updatePinDots();
}

document.querySelectorAll('.num-btn[data-num]').forEach(btn => {
  btn.addEventListener('click', () => {
    if (currentPinInput.length < 4) {
      currentPinInput += btn.getAttribute('data-num');
      updatePinDots();

      if (currentPinInput.length === 4) {
        evaluatePin(currentPinInput);
      }
    }
  });
});

document.getElementById('btnPinClear').addEventListener('click', () => {
  clearPinInput();
});

document.getElementById('btnPinSubmit').addEventListener('click', () => {
  if (currentPinInput.length === 4) {
    evaluatePin(currentPinInput);
  }
});

// Botón para finalizar y cancelar guardia de manera voluntaria
const btnCancelGuard = document.getElementById('btnCancelGuard');
if (btnCancelGuard) {
  btnCancelGuard.addEventListener('click', () => {
    isExitMode = true;
    showNotice('⚠️ Ingresa tu PIN de seguridad para finalizar la guardia', 'warning');
    timerStatusLabel.textContent = 'INGRESA PIN PARA SALIR';

    if (exitModeTimeout) clearTimeout(exitModeTimeout);
    exitModeTimeout = setTimeout(() => {
      isExitMode = false;
      if (timerExpiresAt && timeRemaining > 0) {
        timerStatusLabel.textContent = 'RESTANTE';
      }
    }, 10000);
  });
}

function evaluatePin(pin) {
  // CÓDIGO 1: FALSO / BAJO COACCIÓN -> Dispara la alarma silenciosamente y regresa a seleccionar tiempo
  if (pin === currentProfile.pin_duress) {
    stopWarningTone();
    stopAlarmSiren();
    stopKeepAliveAudio();
    stopBackgroundWorker();
    closeWarningNotification();
    releaseWakeLock();
    clearInterval(timerInterval);
    timerInterval = null;
    timerExpiresAt = null;
    isWarningActive = false;
    isExitMode = false;
    timerContainer.classList.remove('warning-mode', 'danger-mode');
    clearPinInput();

    // Disparo de alarma silenciosa en segundo plano
    triggerAlert('duress_pin_coaccion');
    showScreen('selectTimer');
    return;
  }

  // CÓDIGO 2: PIN DE SEGURIDAD (Cancelar o Reiniciar)
  if (pin === currentProfile.pin_cancel) {
    clearPinInput();

    // Caso A: El usuario pulsó "Finalizar Guardia y Salir"
    if (isExitMode) {
      isExitMode = false;
      if (exitModeTimeout) clearTimeout(exitModeTimeout);
      stopWarningTone();
      stopAlarmSiren();
      stopKeepAliveAudio();
      stopBackgroundWorker();
      closeWarningNotification();
      releaseWakeLock();
      clearInterval(timerInterval);
      timerInterval = null;
      timerExpiresAt = null;
      isWarningActive = false;
      timerContainer.classList.remove('warning-mode', 'danger-mode');

      // Actualizar estado a cancelado en Supabase
      const client = getSupabase();
      if (client && currentUser) {
        client.from('active_timers').update({
          status: 'cancelled',
          alert_triggered: false,
          updated_at: new Date().toISOString()
        }).eq('user_id', currentUser.id);
      }

      showScreen('selectTimer');
      return;
    }

    // Caso B: La alarma ya había sonado (sirena activa) -> apagar sirena y volver
    if (sirenInterval || timerStatusLabel.textContent === 'ALERTA ACTIVADA') {
      stopWarningTone();
      stopAlarmSiren();
      stopKeepAliveAudio();
      stopBackgroundWorker();
      closeWarningNotification();
      releaseWakeLock();
      clearInterval(timerInterval);
      timerInterval = null;
      timerExpiresAt = null;
      isWarningActive = false;
      timerContainer.classList.remove('warning-mode', 'danger-mode');

      const client = getSupabase();
      if (client && currentUser) {
        client.from('active_timers').update({
          status: 'cancelled',
          alert_triggered: false,
          updated_at: new Date().toISOString()
        }).eq('user_id', currentUser.id);
      }

      showScreen('selectTimer');
      return;
    }

    // Caso C: El cronómetro está corriendo o en advertencia de 20 segundos
    // -> REINICIAR EL CRONÓMETRO AL TIEMPO SELECCIONADO (5min, 15min, 30min, 1h)
    stopWarningTone();
    closeWarningNotification();
    isWarningActive = false;
    timerContainer.classList.remove('warning-mode', 'danger-mode');

    // Reiniciar tiempo al total seleccionado
    timeRemaining = selectedDuration;
    timerExpiresAt = Date.now() + selectedDuration * 1000;
    updateTimerUI();
    timerStatusLabel.textContent = 'RESTANTE';

    // Reproducir tono suave de confirmación
    playConfirmationChime();
    if (navigator.vibrate) {
      navigator.vibrate([80, 50, 120]);
    }

    showNotice(`✅ Cronómetro reiniciado (+${formatDurationLabel(selectedDuration)})`, 'success');

    // Actualizar nueva fecha de expiración en Supabase para evitar cualquier disparo
    const client = getSupabase();
    if (client && currentUser) {
      const expiresAtIso = new Date(timerExpiresAt).toISOString();
      client.from('active_timers').update({
        started_at: new Date().toISOString(),
        expires_at: expiresAtIso,
        status: 'running',
        alert_triggered: false,
        updated_at: new Date().toISOString()
      }).eq('user_id', currentUser.id).then(({ error }) => {
        if (error) {
          console.warn('[Supabase Timer Reset Error]:', error.message);
        } else {
          console.log(`🔄 [Timer Reset] Cronómetro renovado exitosamente. Vence a las: ${expiresAtIso}`);
        }
      });
    }

    return;
  }

  // PIN Erróneo
  if (navigator.vibrate) {
    navigator.vibrate([100, 50, 100]);
  }
  showNotice('❌ PIN incorrecto', 'error');
  clearPinInput();
}

// ----------------------------------------------------
// 9. ACTIVACIÓN DE ALERTA (REGISTRO EN SUPABASE & DISPARO EN RENDER)
// ----------------------------------------------------
async function triggerAlert(reason) {
  releaseWakeLock();
  stopWarningTone();
  closeWarningNotification();
  stopKeepAliveAudio();
  stopBackgroundWorker();

  timerContainer.classList.remove('warning-mode');
  timerContainer.classList.add('danger-mode');
  timerStatusLabel.textContent = 'ALERTA ACTIVADA';

  // Sonar sirena potente continua si NO es coacción bajo amenaza
  if (reason !== 'duress_pin_coaccion') {
    playAlarmSiren();
    notifyTimerExpired();
  }

  console.warn(`[SENTINEL] ¡Alerta de emergencia activada! Razón: ${reason}`);

  const client = getSupabase();

  // 1. Actualizar estado en Supabase active_timers
  if (client && currentUser) {
    try {
      await client
        .from('active_timers')
        .update({
          status: reason === 'duress_pin_coaccion' ? 'duress_triggered' : 'expired',
          alert_triggered: true,
          alert_triggered_at: new Date().toISOString(),
          last_latitude: currentGps.latitude,
          last_longitude: currentGps.longitude
        })
        .eq('user_id', currentUser.id);
    } catch (dbErr) {
      console.warn('Error actualizando active_timers en Supabase:', dbErr);
    }
  }

  // 2. Notificar inmediatamente a Render si se desea despacho instantáneo (el poller de 10s también lo detecta)
  if (RENDER_BRIDGE_URL && !RENDER_BRIDGE_URL.includes("tu-servicio")) {
    try {
      fetch(`${RENDER_BRIDGE_URL}/dispatch-immediate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: currentUser ? currentUser.id : null,
          reason: reason,
          latitude: currentGps.latitude,
          longitude: currentGps.longitude
        })
      }).then(r => r.json()).then(res => {
        console.log('[Render Worker] Despacho inmediato completado:', res);
      }).catch(err => {
        console.log('[Render Worker Info]: El Poller continuo de 10s en Render procesará la alerta.');
      });
    } catch (e) {}
  }
}

// ----------------------------------------------------
// 10. INICIALIZACIÓN Y SERVICE WORKER PWA
// ----------------------------------------------------
window.addEventListener('DOMContentLoaded', async () => {
  // Iniciar geolocalización
  initGeolocation();

  // Comprobar si hay una sesión activa de Supabase persistida
  const client = getSupabase();
  if (client && client.auth) {
    try {
      const { data: { session }, error: sessionErr } = await client.auth.getSession();
      if (session && session.user) {
        currentUser = session.user;
        const { data: profile } = await client.from('profiles').select('*').eq('id', currentUser.id).maybeSingle();
        if (profile) {
          currentProfile = profile;
          document.getElementById('userBadge').textContent = profile.first_name || currentUser.email.split('@')[0];
        } else {
          document.getElementById('userBadge').textContent = currentUser.email ? currentUser.email.split('@')[0] : 'Usuario';
        }
        await loadContactsFromSupabase();

        // Verificar si había un cronómetro corriendo para reanudarlo
        const { data: activeTimer } = await client
          .from('active_timers')
          .select('*')
          .eq('user_id', currentUser.id)
          .eq('status', 'running')
          .maybeSingle();

        if (activeTimer) {
          if (new Date(activeTimer.expires_at) > new Date()) {
            const remainingSecs = Math.max(1, Math.floor((new Date(activeTimer.expires_at).getTime() - Date.now()) / 1000));
            resumeRunningTimer(remainingSecs, activeTimer.duration_seconds);
          } else {
            // Venció mientras el navegador estaba cerrado o suspendido
            showScreen('timerActive');
            triggerAlert('timer_expired');
          }
        } else if (contacts.length > 0) {
          showScreen('selectTimer');
        } else {
          showScreen('contacts');
        }
      } else {
        showScreen('login');
      }
    } catch (e) {
      console.error('Error al restaurar sesión de Supabase:', e);
      showScreen('login');
    }

    // Escuchar eventos de cierre de sesión
    client.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') {
        currentUser = null;
        contacts = [];
        renderContacts();
        document.getElementById('userBadge').textContent = 'Desconectado';
        showScreen('login');
      }
    });
  } else {
    showScreen('login');
  }

  // Registrar Service Worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js')
      .then(reg => console.log('ServiceWorker registrado:', reg.scope))
      .catch(err => console.error('Error ServiceWorker:', err));
  }
});
