const { createClient } = window.supabase;

const sb = createClient(
  'https://cbplebkmxrkaafqdhiyi.supabase.co',
  'sb_publishable_DZCceNTENY4ViP17-eZrGg_bdMElZ9X'
);

const LOGIN_LOCK_TABLE = 'user_login_locks';
const LOCK_TOKEN_KEY = 'combuses_lock_token';
const LOCK_HEARTBEAT_MS = 60 * 1000;
const LOCK_STALE_MS = 12 * 60 * 60 * 1000;

const loginForm = document.getElementById('loginForm');
const loginEmail = document.getElementById('loginEmail');
const loginPassword = document.getElementById('loginPassword');
const loginMessage = document.getElementById('loginMessage');

if (!loginForm || !loginEmail || !loginPassword || !loginMessage) {
  throw new Error('Faltan elementos del formulario de login.');
}

let lockHeartbeatTimer = null;

function getOrCreateLockToken() {
  let token = localStorage.getItem(LOCK_TOKEN_KEY);
  if (token) return token;
  token = (window.crypto && typeof window.crypto.randomUUID === 'function')
    ? window.crypto.randomUUID()
    : `lk_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
  localStorage.setItem(LOCK_TOKEN_KEY, token);
  return token;
}

function setLoginMessage(type, text) {
  loginMessage.className = `message ${type}`;
  loginMessage.textContent = text;
}

async function ensureProfile(user) {
  if (!user) return;

  const meta = user.user_metadata || {};
  const username = meta.username || user.email?.split('@')[0] || `user_${user.id.slice(0, 8)}`;
  const fullName = meta.full_name || '';

  const { error } = await sb.from('profiles').upsert(
    {
      id: user.id,
      username,
      full_name: fullName
    },
    { onConflict: 'id' }
  );

  if (error) throw error;
}

function isLockStale(row) {
  if (!row?.last_seen_at) return true;
  const lastSeen = new Date(row.last_seen_at).getTime();
  if (Number.isNaN(lastSeen)) return true;
  return (Date.now() - lastSeen) > LOCK_STALE_MS;
}

async function acquireLoginLock(userId) {
  const token = getOrCreateLockToken();
  const now = new Date().toISOString();

  const { data: existing, error: readError } = await sb
    .from(LOGIN_LOCK_TABLE)
    .select('user_id, session_token, active, last_seen_at')
    .eq('user_id', userId)
    .limit(1)
    .maybeSingle();

  if (readError) {
    throw new Error('No se pudo validar sesion activa. Configura la tabla user_login_locks.');
  }

  const occupiedByOther = existing && existing.active && existing.session_token !== token && !isLockStale(existing);
  if (occupiedByOther) {
    return { ok: false, message: 'Este usuario ya tiene una sesion activa en otro navegador/dispositivo.' };
  }

  const { error: upsertError } = await sb
    .from(LOGIN_LOCK_TABLE)
    .upsert(
      [{
        user_id: userId,
        session_token: token,
        active: true,
        last_seen_at: now
      }],
      { onConflict: 'user_id' }
    );

  if (upsertError) {
    throw new Error('No se pudo registrar el bloqueo de sesion.');
  }

  return { ok: true };
}

async function refreshLoginLock(userId) {
  const token = getOrCreateLockToken();
  await sb
    .from(LOGIN_LOCK_TABLE)
    .update({
      active: true,
      last_seen_at: new Date().toISOString()
    })
    .eq('user_id', userId)
    .eq('session_token', token);
}

function startLockHeartbeat(userId) {
  if (lockHeartbeatTimer) {
    clearInterval(lockHeartbeatTimer);
    lockHeartbeatTimer = null;
  }
  lockHeartbeatTimer = setInterval(() => {
    refreshLoginLock(userId).catch(() => {});
  }, LOCK_HEARTBEAT_MS);
}

window.addEventListener('beforeunload', () => {
  if (lockHeartbeatTimer) {
    clearInterval(lockHeartbeatTimer);
    lockHeartbeatTimer = null;
  }
});

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  try {
    setLoginMessage('success', 'Validando acceso...');

    const { data, error } = await sb.auth.signInWithPassword({
      email: loginEmail.value.trim(),
      password: loginPassword.value
    });

    if (error) throw error;
    if (!data.user) throw new Error('No se pudo iniciar sesion.');

    try {
      await ensureProfile(data.user);
    } catch (profileErr) {
      console.warn('No se pudo crear/actualizar perfil:', profileErr.message);
    }

    const lock = await acquireLoginLock(data.user.id);
    if (!lock.ok) {
      await sb.auth.signOut();
      throw new Error(lock.message);
    }

    startLockHeartbeat(data.user.id);

    setLoginMessage('success', 'Acceso autorizado. Redirigiendo...');
    setTimeout(() => { location.href = 'monitor.html'; }, 700);
  } catch (err) {
    setLoginMessage('error', err.message);
  }
});

(async () => {
  try {
    const { data: { user }, error } = await sb.auth.getUser();
    if (error) throw error;
    if (!user) return;

    const lock = await acquireLoginLock(user.id);
    if (!lock.ok) {
      await sb.auth.signOut();
      setLoginMessage('error', lock.message);
      return;
    }

    startLockHeartbeat(user.id);
    location.href = 'monitor.html';
  } catch (err) {
    setLoginMessage('error', err.message);
  }
})();

