const { createClient } = window.supabase;

const sb = createClient(
  'https://cbplebkmxrkaafqdhiyi.supabase.co',
  'sb_publishable_DZCceNTENY4ViP17-eZrGg_bdMElZ9X'
);

const realtimeStatus = document.getElementById('realtimeStatus');
const rowsCount = document.getElementById('rowsCount');
const monitorBody = document.getElementById('monitorBody');
const monitorEmpty = document.getElementById('monitorEmpty');
const monitorPrevBtn = document.getElementById('monitorPrevBtn');
const monitorNextBtn = document.getElementById('monitorNextBtn');
const monitorPageInfo = document.getElementById('monitorPageInfo');
const refreshBtn = document.getElementById('refreshBtn');
const logoutBtn = document.getElementById('logoutBtn');
const dispatchNotifyModal = document.getElementById('dispatchNotifyModal');
const dispatchNotifyText = document.getElementById('dispatchNotifyText');
const dispatchNotifyClose = document.getElementById('dispatchNotifyClose');

let rows = [];
let channel = null;
let fallbackTimer = null;
let isInitialLoadDone = false;
let currentPage = 1;
let hasNextPage = false;
const PAGE_SIZE = 10;
const knownDispatchIds = new Set();
const notifyQueue = [];
let notifyInProgress = false;
let notifyTimeout = null;
let updateRefreshTimer = null;
let audioUnlocked = false;
const NOTIFY_DURATION_MS = 12000;
const NOTIFY_BEEP_MS = 180;
const NOTIFY_BEEP_GAP_MS = 130;
const NOTIFY_BEEP_REPEAT = 3;

function formatDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString('es-CO', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
}

function formatTime24(value, fallback = '-') {
  if (!value) return fallback;
  const asText = String(value);
  if (/^\d{2}:\d{2}(:\d{2})?$/.test(asText)) return asText.slice(0, 5);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return date.toLocaleTimeString('es-CO', {
    timeZone: 'America/Bogota',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
}

function getSortTs(row) {
  const ts = new Date(row.created_at || row.departure_time || 0).getTime();
  return Number.isNaN(ts) ? 0 : ts;
}

function render() {
  const ordered = [...rows].sort((a, b) => getSortTs(b) - getSortTs(a)).slice(0, PAGE_SIZE);
  rowsCount.textContent = `${ordered.length} registros en pagina`;
  monitorPageInfo.textContent = `Pagina ${currentPage}`;
  monitorPrevBtn.disabled = currentPage <= 1;
  monitorNextBtn.disabled = !hasNextPage;

  if (ordered.length === 0) {
    monitorBody.innerHTML = '';
    monitorEmpty.style.display = 'block';
    monitorEmpty.textContent = 'No hay despachos para mostrar.';
    return;
  }

  monitorEmpty.style.display = 'none';
  monitorBody.innerHTML = ordered.map((row) => {
    const dateText = formatDate(row.departure_time || row.created_at);
    const timeText = formatTime24(row.hora_salida || row.departure_time);
    return `
      <tr>
        <td>${dateText}</td>
        <td>${timeText}</td>
        <td>${row.vehicle || '-'}</td>
        <td>${row.route || '-'}</td>
        <td>${row.manager || '-'}</td>
      </tr>
    `;
  }).join('');
}

function formatNotifyText(row) {
  const dateText = formatDate(row.departure_time || row.created_at);
  const timeText = formatTime24(row.hora_salida || row.departure_time);
  return `Fecha: ${dateText}\nHora: ${timeText}\nVehiculo: ${row.vehicle || '-'}\nRuta: ${row.route || '-'}\nGestor: ${row.manager || '-'}`;
}

function unlockAudioOnce() {
  audioUnlocked = true;
  window.removeEventListener('pointerdown', unlockAudioOnce);
  window.removeEventListener('keydown', unlockAudioOnce);
}

function playAlertSound() {
  if (!audioUnlocked) return;
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return;

  let ctx;
  try {
    ctx = new AudioCtx();
  } catch (err) {
    return;
  }

  if (ctx.state === 'suspended') {
    ctx.resume().catch(() => {});
  }

  const now = ctx.currentTime;
  for (let i = 0; i < NOTIFY_BEEP_REPEAT; i += 1) {
    const start = now + i * ((NOTIFY_BEEP_MS + NOTIFY_BEEP_GAP_MS) / 1000);
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = i % 2 === 0 ? 980 : 720;
    gain.gain.value = 0.001;
    gain.gain.exponentialRampToValueAtTime(0.22, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, start + (NOTIFY_BEEP_MS / 1000));
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(start);
    osc.stop(start + (NOTIFY_BEEP_MS / 1000));
  }

  const totalMs = (NOTIFY_BEEP_REPEAT * (NOTIFY_BEEP_MS + NOTIFY_BEEP_GAP_MS)) + 200;
  setTimeout(() => {
    ctx.close().catch(() => {});
  }, totalMs);
}

function closeDispatchNotification() {
  dispatchNotifyModal.style.display = 'none';
  if (notifyTimeout) {
    clearTimeout(notifyTimeout);
    notifyTimeout = null;
  }
}

function showDispatchNotification(row) {
  return new Promise((resolve) => {
    dispatchNotifyText.textContent = formatNotifyText(row);
    dispatchNotifyModal.style.display = 'flex';
    playAlertSound();
    if (navigator.vibrate) {
      navigator.vibrate([180, 100, 180, 100, 220]);
    }

    const onClose = () => {
      cleanup();
      resolve();
    };

    const onBackdrop = (e) => {
      if (e.target === dispatchNotifyModal) {
        cleanup();
        resolve();
      }
    };

    function cleanup() {
      dispatchNotifyClose.removeEventListener('click', onClose);
      dispatchNotifyModal.removeEventListener('click', onBackdrop);
      closeDispatchNotification();
    }

    dispatchNotifyClose.addEventListener('click', onClose);
    dispatchNotifyModal.addEventListener('click', onBackdrop);
    notifyTimeout = setTimeout(() => {
      cleanup();
      resolve();
    }, NOTIFY_DURATION_MS);
  });
}

async function flushNotifyQueue() {
  if (notifyInProgress) return;
  notifyInProgress = true;
  try {
    while (notifyQueue.length > 0) {
      const row = notifyQueue.shift();
      await showDispatchNotification(row);
    }
  } finally {
    notifyInProgress = false;
  }
}

function enqueueDispatchNotification(row) {
  if (!row || !row.id) return;
  notifyQueue.push(row);
  flushNotifyQueue();
}

function registerKnownRows(data, notifyNew) {
  const incoming = data || [];
  const fresh = [];
  for (const row of incoming) {
    const id = Number(row.id || 0);
    if (!id) continue;
    const existed = knownDispatchIds.has(id);
    knownDispatchIds.add(id);
    if (notifyNew && !existed) fresh.push(row);
  }

  if (fresh.length > 0) {
    fresh
      .sort((a, b) => getSortTs(a) - getSortTs(b))
      .forEach((row) => enqueueDispatchNotification(row));
  }
}

async function loadInitial(notifyNew = false) {
  const from = (currentPage - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE;

  const { data, error } = await sb
    .from('dispatches')
    .select('id, departure_time, hora_salida, vehicle, route, manager, created_at')
    .order('created_at', { ascending: false })
    .range(from, to);

  if (error) throw error;
  const list = data || [];
  hasNextPage = list.length > PAGE_SIZE;
  rows = list.slice(0, PAGE_SIZE);
  registerKnownRows(rows, notifyNew && isInitialLoadDone);
  isInitialLoadDone = true;
  render();
}

function upsertRowFromInsert(newRow) {
  if (!newRow) return;
  const id = Number(newRow.id || 0);
  if (!id) return;

  const exists = rows.some((r) => Number(r.id || 0) === id);
  if (exists) return;
  knownDispatchIds.add(id);
  if (currentPage === 1) {
    rows.unshift(newRow);
    if (rows.length > PAGE_SIZE) rows.length = PAGE_SIZE;
  }
  render();
  enqueueDispatchNotification(newRow);
}

function scheduleUpdateRefresh() {
  if (updateRefreshTimer) return;
  updateRefreshTimer = setTimeout(async () => {
    updateRefreshTimer = null;
    try {
      await loadInitial(false);
    } catch (err) {
      // Ignorado: se reintenta por fallback/polling.
    }
  }, 5000);
}

function setStatus(text, kind) {
  realtimeStatus.textContent = text;
  realtimeStatus.className = `badge ${kind}`;
}

function subscribeRealtime() {
  if (channel) {
    sb.removeChannel(channel);
    channel = null;
  }

  channel = sb
    .channel('dispatches-monitor-realtime')
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'dispatches'
    }, (payload) => {
      upsertRowFromInsert(payload.new);
    })
    .on('postgres_changes', {
      event: 'UPDATE',
      schema: 'public',
      table: 'dispatches'
    }, () => {
      // Agrupa multiples updates cercanos para evitar recargas continuas.
      scheduleUpdateRefresh();
    })
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        setStatus('Realtime activo', 'ok');
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        setStatus('Realtime con fallo', 'err');
      } else {
        setStatus(`Estado: ${status}`, 'warn');
      }
    });
}

function startFallbackRefresh() {
  if (fallbackTimer) {
    clearInterval(fallbackTimer);
    fallbackTimer = null;
  }

  // Respaldo liviano: evita depender al 100% de Realtime sin gastar de mas.
  fallbackTimer = setInterval(() => {
    if (document.hidden) return;
    if (currentPage !== 1) return;
    loadInitial(true).catch(() => {});
  }, 90000);
}

monitorPrevBtn.addEventListener('click', async () => {
  if (currentPage <= 1) return;
  currentPage -= 1;
  try {
    await loadInitial(false);
  } catch (err) {
    currentPage += 1;
  }
});

monitorNextBtn.addEventListener('click', async () => {
  if (!hasNextPage) return;
  currentPage += 1;
  try {
    await loadInitial(false);
  } catch (err) {
    currentPage -= 1;
  }
});

refreshBtn.addEventListener('click', async () => {
  try {
    setStatus('Refrescando...', 'warn');
    await loadInitial(false);
    setStatus('Realtime activo', 'ok');
  } catch (err) {
    setStatus('Error de carga', 'err');
    monitorEmpty.style.display = 'block';
    monitorEmpty.textContent = `Error: ${err.message}`;
  }
});

logoutBtn.addEventListener('click', async () => {
  await sb.auth.signOut();
  location.href = 'index.html';
});

(async function init() {
  try {
    const { data: { user }, error } = await sb.auth.getUser();
    if (error || !user) {
      location.href = 'index.html';
      return;
    }

    await loadInitial(false);
    window.addEventListener('pointerdown', unlockAudioOnce, { once: true });
    window.addEventListener('keydown', unlockAudioOnce, { once: true });
    subscribeRealtime();
    startFallbackRefresh();
  } catch (err) {
    setStatus('Error de carga', 'err');
    monitorEmpty.style.display = 'block';
    monitorEmpty.textContent = `Error: ${err.message}`;
  }
})();

window.addEventListener('beforeunload', () => {
  if (channel) {
    sb.removeChannel(channel);
    channel = null;
  }
  if (fallbackTimer) {
    clearInterval(fallbackTimer);
    fallbackTimer = null;
  }
  if (updateRefreshTimer) {
    clearTimeout(updateRefreshTimer);
    updateRefreshTimer = null;
  }
  closeDispatchNotification();
});
