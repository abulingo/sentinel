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
// 1. SISTEMA DE AUDIO Y VIBRACIÓN DISTINTIVOS (Web Audio API)
// ----------------------------------------------------
function initAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
}

// Sonido penetrante y único para Alerta Temprana (bip oscilante bifrecuencia)
function playWarningTone() {
  try {
    initAudio();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();

    osc.type = 'sawtooth';
    // Frecuencia dual penetrante distinta a notificaciones convencionales
    osc.frequency.setValueAtTime(880, audioCtx.currentTime); // La5
    osc.frequency.exponentialRampToValueAtTime(1760, audioCtx.currentTime + 0.2); // La6

    gain.gain.setValueAtTime(0.3, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.35);

    osc.connect(gain);
    gain.connect(audioCtx.destination);

    osc.start();
    osc.stop(audioCtx.currentTime + 0.35);
  } catch (err) {
    console.error("Audio error:", err);
  }

  // Patrón de vibración continuo de alerta: [vibrar, pausa, vibrar, pausa]
  if (navigator.vibrate) {
    navigator.vibrate([300, 100, 300, 100, 500]);
  }
}

// SIRENA DE ALARMA CONTINUA Y POTENTE (Al vencerse el cronómetro)
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

        gain.gain.setValueAtTime(0.8, now);
        gain.gain.setValueAtTime(0.8, now + 0.45);
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

function notifyTimerExpired() {
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      const notif = new Notification('🚨 ¡SENTINEL: ALERTA ACTIVADA! 🚨', {
        body: 'El cronómetro de seguridad ha vencido sin respuesta. Se han despachado llamadas y mensajes de auxilio.',
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
// 2. GEOLOCALIZACIÓN CONSTANTE Y ENVÍO CADA 20 SEGUNDOS
// ----------------------------------------------------
let gpsIntervalId = null;
let lastGpsSyncTime = null;
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
    if (timerExpiresAt && timerInterval) {
      checkTimerStatus();
    }
    if (timerInterval && !wakeLockSentinel) {
      requestWakeLock();
    }
  }
});

window.addEventListener('focus', () => {
  if (timerExpiresAt && timerInterval) {
    checkTimerStatus();
  }
});

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

    // 2. Escuchar cambios de coordenadas por movimiento
    navigator.geolocation.watchPosition(
      (pos) => {
        updateGpsCoords(pos);
      },
      (err) => console.warn('[GPS Watch Warning]:', err.message),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 }
    );

    // 3. Envío constante cada 20 segundos a Supabase
    if (!gpsIntervalId) {
      gpsIntervalId = setInterval(() => {
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            updateGpsCoords(pos);
            updateLocationInSupabase();
          },
          (err) => {
            // Si la antena demora, enviar la última posición válida en memoria
            if (currentGps.latitude !== null && currentGps.longitude !== null) {
              updateLocationInSupabase();
            }
          },
          { enableHighAccuracy: true, timeout: 6000, maximumAge: 15000 }
        );
      }, 20000); // 20 segundos exactos
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
      console.log(`📍 [GPS 20s Sync] Ubicación enviada a Supabase: ${currentGps.latitude.toFixed(5)}, ${currentGps.longitude.toFixed(5)} (±${Math.round(currentGps.accuracy)}m) a las ${lastGpsSyncTime.toLocaleTimeString()}`);
      
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

async function startTimer(durationSeconds) {
  selectedDuration = durationSeconds;
  timeRemaining = durationSeconds;
  timerExpiresAt = Date.now() + durationSeconds * 1000;
  clearPinInput();
  showScreen('timerActive');

  // Solicitar permiso de notificaciones para alertar si el usuario cambia de app
  if ('Notification' in window && Notification.permission === 'default') {
    try {
      Notification.requestPermission();
    } catch (e) {}
  }

  // Activar audio context con el primer click del usuario
  initAudio();
  requestWakeLock();

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

  // UMBRAL DE ADVERTENCIA:
  const warningThreshold = selectedDuration <= 30 ? 5 : Math.min(60, selectedDuration * 0.2);

  if (timeRemaining <= warningThreshold && timeRemaining > 0) {
    playWarningTone();
    timerContainer.classList.add('warning-mode');
    timerStatusLabel.textContent = '¡ATENCIÓN: INGRESA PIN!';
  } else if (timeRemaining > warningThreshold) {
    timerContainer.classList.remove('warning-mode');
  }

  if (timeRemaining <= 0) {
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
  showScreen('timerActive');

  initAudio();
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

function evaluatePin(pin) {
  // CÓDIGO 1: FALSO / BAJO COACCIÓN -> Dispara la alarma silenciosamente y regresa a seleccionar tiempo
  if (pin === currentProfile.pin_duress) {
    clearInterval(timerInterval);
    timerInterval = null;
    timerExpiresAt = null;
    releaseWakeLock();
    stopAlarmSiren();
    timerContainer.classList.remove('warning-mode', 'danger-mode');
    clearPinInput();
    // Disparo de alarma silenciosa en segundo plano
    triggerAlert('duress_pin_coaccion');
    // Regresar al inicio para seleccionar tiempo
    showScreen('selectTimer');
    return;
  }

  // CÓDIGO 2: INICIO / CANCELAR -> Vuelve a la pantalla de selección de tiempo
  if (pin === currentProfile.pin_cancel) {
    clearInterval(timerInterval);
    timerInterval = null;
    timerExpiresAt = null;
    releaseWakeLock();
    stopAlarmSiren();
    timerContainer.classList.remove('warning-mode', 'danger-mode');
    clearPinInput();

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

  // PIN Erróneo
  alert('Código incorrecto.');
  clearPinInput();
}

function showNotice(msg) {
  timerStatusLabel.textContent = msg;
  setTimeout(() => {
    timerStatusLabel.textContent = 'RESTANTE';
  }, 2000);
}

// ----------------------------------------------------
// 9. ACTIVACIÓN DE ALERTA (REGISTRO EN SUPABASE & DISPARO EN RENDER)
// ----------------------------------------------------
async function triggerAlert(reason) {
  releaseWakeLock();
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
