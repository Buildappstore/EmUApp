const API_BASE = (window.API_BASE_URL || '').replace(/\/+$/, '');

async function apiFetch(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...(options.headers || {}) },
    ...options,
  });

  if (!res.ok) {
    const text = await res.text();
    let message = text || `Request failed: ${res.status}`;
    if (res.headers.get('content-type')?.includes('application/json')) {
      message = JSON.parse(text).error || message;
    }
    throw new Error(message);
  }

  return res.headers.get('content-type')?.includes('application/json') ? res.json() : res.text();
}

function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('roms-lib', 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      db.createObjectStore('meta', { keyPath: 'id', autoIncrement: true });
      db.createObjectStore('files');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function addLocalRom(meta, blob) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const t = db.transaction(['meta', 'files'], 'readwrite');
    const rq = t.objectStore('meta').add(meta);
    rq.onsuccess = () => t.objectStore('files').put(blob, rq.result);
    t.oncomplete = () => res(rq.result);
    t.onerror = t.onabort = () => rej(t.error);
  });
}

async function listLocalRoms() {
  const db = await openDB();
  return new Promise((res, rej) => {
    const rq = db.transaction('meta').objectStore('meta').getAll();
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
}

async function getLocalRom(id) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const t = db.transaction(['meta', 'files']);
    const m = t.objectStore('meta').get(id);
    const f = t.objectStore('files').get(id);
    t.oncomplete = () => res({ meta: m.result, blob: f.result });
    t.onerror = () => rej(t.error);
  });
}

async function addRom(meta, blob) {
  try {
    if (!blob || typeof blob.name !== 'string') {
      throw new Error('Archivo sin nombre');
    }

    const formData = new FormData();
    formData.append('file', blob, blob.name);
    formData.append('name', blob.name);
    formData.append('core', meta.core);

    const data = await apiFetch('/api/roms/upload', {
      method: 'POST',
      body: formData,
    });

    return data;
  } catch (error) {
    console.warn('Fallo del backend B2, usando IndexedDB local:', error);
    return addLocalRom(meta, blob);
  }
}

async function setRomCover(id, file) {
  const formData = new FormData();
  formData.append('id', String(id));
  formData.append('cover', file, file.name);
  return await apiFetch('/api/roms/cover', {
    method: 'PUT',
    body: formData,
  });
}

async function setRomCore(id, core) {
  return await apiFetch('/api/roms/core', {
    method: 'PUT',
    body: JSON.stringify({ id: String(id), core }),
  });
}

async function listRoms() {
  return await apiFetch('/api/roms');
}

async function getRom(id) {
  try {
    const data = await apiFetch(`/api/roms/${encodeURIComponent(String(id))}`);
    return { meta: data, blob: data.url || null };
  } catch (error) {
    console.warn('No se pudo obtener ROM desde B2, usando IndexedDB local:', error);
    return getLocalRom(id);
  }
}
