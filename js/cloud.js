/* ============================================================
   Orion Empires — Cloud sync (Supabase) (decisione di sessione)
   ============================================================
   Sync centralizzato dei salvataggi via PostgREST di Supabase.
   Single user, no auth: la chiave anon e' incollata in CFG
   (decisione utente "hardcoded"). Il payload nel cloud e'
   identico al JSON di export di ORION.save (schema corrente).

   Slot remoti:
     - 'autosave'         (rotante 1, agganciato a ORION.save.autosave)
     - 's0' .. 's4'       (specchio dei 5 slot manuali)

   Politica conflitti (decisione utente): piu' recente vince.
     - Reconciliation al boot:
         cloud_ts > local_ts → backup .json del locale + applica cloud
         local_ts > cloud_ts → push del locale
         uguali               → niente
     - Backup .json scaricato automaticamente prima di sovrascrivere
       (recovery-friendly, decisione #22).

   Niente bump di schema: il cloud trasporta lo stesso ORION.save.serialize.
   ============================================================ */
(function (root) {
  const ORION = root.ORION || (root.ORION = {});

  const CFG = {
    URL:        'https://xtfjqwdzpivtnlmqkdxk.supabase.co',
    ANON_KEY:   'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh0Zmpxd2R6cGl2dG5sbXFrZHhrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2MDYxNjgsImV4cCI6MjA5NzE4MjE2OH0.77T0uCxIExk2cy6NPkp7oRBodiLee_ZPP-Ers8UUeZA',
    TABLE:      'saves',
    DEBOUNCE_MS: 5000,
    TIMEOUT_MS:  8000,
    BOOT_TIMEOUT_MS: 6000,
    BACKUP_KEEP: 5            /* ultimi N .json di backup in localStorage */
  };

  /* Preferenza utente: cloud ON/OFF, vive in localStorage (mai nel save). */
  const PREF_KEY = 'orion.cloud.enabled';
  function isEnabled() {
    const v = localStorage.getItem(PREF_KEY);
    /* default: abilitato */
    return v === null ? true : v === '1';
  }
  function setEnabled(on) { localStorage.setItem(PREF_KEY, on ? '1' : '0'); }

  /* Stato volatile (non serializzato). Esposto per UI/toast. */
  const STATE = {
    status: 'idle',        /* 'idle'|'syncing'|'ok'|'error'|'offline' */
    lastSyncAt: 0,
    lastError: null,
    pendingTimer: null,
    pendingSlot: null,
    listeners: []
  };
  function emit() { STATE.listeners.forEach(function (fn) { try { fn(STATE); } catch (e) {} }); }
  function onChange(fn) { STATE.listeners.push(fn); }
  function setStatus(s, err) {
    STATE.status = s;
    STATE.lastError = err || null;
    if (s === 'ok') STATE.lastSyncAt = Date.now();
    emit();
  }

  /* ---------- low-level REST ---------- */
  function headers(extra) {
    const h = {
      'apikey':        CFG.ANON_KEY,
      'Authorization': 'Bearer ' + CFG.ANON_KEY,
      'Content-Type':  'application/json',
      'Accept':        'application/json'
    };
    if (extra) Object.keys(extra).forEach(function (k) { h[k] = extra[k]; });
    return h;
  }

  function fetchWithTimeout(url, opts, timeoutMs) {
    const ctrl = new AbortController();
    const t = setTimeout(function () { ctrl.abort(); }, timeoutMs || CFG.TIMEOUT_MS);
    return fetch(url, Object.assign({}, opts || {}, { signal: ctrl.signal }))
      .finally(function () { clearTimeout(t); });
  }

  function endpoint(qs) {
    return CFG.URL + '/rest/v1/' + CFG.TABLE + (qs ? ('?' + qs) : '');
  }

  function listRemote() {
    return fetchWithTimeout(endpoint('select=*'), { headers: headers() })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      });
  }

  function pullRemote(slot) {
    const qs = 'slot=eq.' + encodeURIComponent(slot) + '&select=*';
    return fetchWithTimeout(endpoint(qs), { headers: headers() })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json().then(function (arr) { return (arr && arr[0]) || null; });
      });
  }

  function pushRemote(slot, payload, meta) {
    const body = {
      slot:         slot,
      payload:      payload,
      schema:       (payload && payload.schema) || 0,
      seed:         (payload && payload.seed) || null,
      empire_label: (meta && meta.empireLabel) || null,
      ds_label:     (meta && meta.dsLabel) || null
    };
    const opts = {
      method:  'POST',
      headers: headers({ 'Prefer': 'resolution=merge-duplicates,return=representation' }),
      body:    JSON.stringify(body)
    };
    return fetchWithTimeout(endpoint('on_conflict=slot'), opts)
      .then(function (r) {
        if (!r.ok) return r.text().then(function (t) { throw new Error('HTTP ' + r.status + ' ' + t); });
        return r.json();
      });
  }

  function deleteRemote(slot) {
    const qs = 'slot=eq.' + encodeURIComponent(slot);
    const opts = { method: 'DELETE', headers: headers() };
    return fetchWithTimeout(endpoint(qs), opts)
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return true;
      });
  }

  /* ---------- helpers ---------- */
  function payloadOfGame(game) {
    /* riusa la serializzazione canonica (schema corrente). */
    return ORION.save && ORION.save.serialize ? ORION.save.serialize(game) : null;
  }

  function metaOfGame(game) {
    if (!game) return {};
    const empireLabel = (function () {
      const e = game.empire;
      if (!e || !e.proper) return null;
      const A = (ORION.ai && ORION.ai.ARCHETYPES) || {};
      const all = [].concat(A.bene || [], A.neutrale || [], A.male || []);
      const a = all.find(function (x) { return x.id === e.prefix; }) || { noun: 'Repubblica' };
      return a.noun + ' ' + (a.direct ? '' : 'di ') + e.proper;
    })();
    const dsLabel = (ORION.time && ORION.time.format)
      ? ORION.time.format(game.timeImpulsi || 0, 'compact') : null;
    return { empireLabel: empireLabel, dsLabel: dsLabel };
  }

  function localAutosaveMeta() {
    try {
      const raw = localStorage.getItem('orion.saves.v3');
      if (!raw) return null;
      const store = JSON.parse(raw);
      if (!store || !store.autosave) return null;
      return store.autosave;   /* { payload, name, ts } */
    } catch (e) { return null; }
  }

  function localSlotMeta(idx) {
    try {
      const raw = localStorage.getItem('orion.saves.v3');
      if (!raw) return null;
      const store = JSON.parse(raw);
      if (!store || !store.slots) return null;
      return store.slots[idx] || null;
    } catch (e) { return null; }
  }

  /* Sovrascrive uno slot locale con un payload remoto (post-reconcile). */
  function writeLocalAutosave(remoteRow) {
    try {
      const raw = localStorage.getItem('orion.saves.v3');
      const store = raw ? JSON.parse(raw) : { autosave: null, slots: [null, null, null, null, null] };
      store.autosave = {
        payload: remoteRow.payload,
        name: 'Autosave',
        ts: new Date(remoteRow.updated_at).getTime() || Date.now()
      };
      localStorage.setItem('orion.saves.v3', JSON.stringify(store));
      return true;
    } catch (e) { return false; }
  }
  function writeLocalSlot(idx, remoteRow) {
    try {
      const raw = localStorage.getItem('orion.saves.v3');
      const store = raw ? JSON.parse(raw) : { autosave: null, slots: [null, null, null, null, null] };
      store.slots[idx] = {
        payload: remoteRow.payload,
        name: 'Slot ' + (idx + 1),
        ts: new Date(remoteRow.updated_at).getTime() || Date.now()
      };
      localStorage.setItem('orion.saves.v3', JSON.stringify(store));
      return true;
    } catch (e) { return false; }
  }

  /* Backup .json automatico del payload locale prima della sovrascrittura.
     Salva nel localStorage (max BACKUP_KEEP) + scarica .json. */
  function backupLocalPayload(payload, label) {
    if (!payload) return null;
    const filename = (ORION.save && ORION.save.exportFilename)
      ? ORION.save.exportFilename(payload).replace(/\.json$/, '_backup_' + (label || 'pre-cloud') + '.json')
      : ('orion_backup_' + Date.now() + '.json');
    /* localStorage backup (ring buffer) */
    try {
      const KEY = 'orion.backups';
      const arr = JSON.parse(localStorage.getItem(KEY) || '[]');
      arr.push({ ts: Date.now(), filename: filename, payload: payload });
      while (arr.length > CFG.BACKUP_KEEP) arr.shift();
      localStorage.setItem(KEY, JSON.stringify(arr));
    } catch (e) { /* spazio insufficiente: pazienza, scarichiamo comunque */ }
    /* Download automatico (recovery-friendly: l'utente ha sempre il vecchio). */
    try {
      const blob = new Blob([JSON.stringify(payload, null, 0)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click();
      setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
    } catch (e) { /* download bloccato: il backup vive comunque in localStorage */ }
    return filename;
  }

  /* ---------- API alta ---------- */
  function schedulePush(slot, game) {
    if (!isEnabled() || !game) return;
    /* Coalesce: se c'e' gia' un timer per lo stesso slot, posticipa. */
    if (STATE.pendingTimer) { clearTimeout(STATE.pendingTimer); }
    STATE.pendingSlot = slot;
    STATE.pendingTimer = setTimeout(function () {
      STATE.pendingTimer = null;
      const payload = payloadOfGame(game);
      const meta = metaOfGame(game);
      if (!payload) return;
      setStatus('syncing');
      pushRemote(slot, payload, meta)
        .then(function () { setStatus('ok'); })
        .catch(function (err) { setStatus('error', String(err && err.message || err)); });
    }, CFG.DEBOUNCE_MS);
  }

  /* Push immediato (es. dopo "Sovrascrivi" manuale). */
  function pushNow(slot, game) {
    if (!isEnabled() || !game) return Promise.resolve(null);
    const payload = payloadOfGame(game);
    if (!payload) return Promise.resolve(null);
    setStatus('syncing');
    return pushRemote(slot, payload, metaOfGame(game))
      .then(function (r) { setStatus('ok'); return r; })
      .catch(function (err) { setStatus('error', String(err && err.message || err)); throw err; });
  }

  function del(slot) {
    if (!isEnabled()) return Promise.resolve(false);
    setStatus('syncing');
    return deleteRemote(slot)
      .then(function () { setStatus('ok'); return true; })
      .catch(function (err) { setStatus('error', String(err && err.message || err)); return false; });
  }

  function list() {
    if (!isEnabled()) return Promise.resolve([]);
    return listRemote();
  }

  function pull(slot) {
    if (!isEnabled()) return Promise.resolve(null);
    return pullRemote(slot);
  }

  /* ----------------------------------------------------------
     Reconciliation al boot — solo autosave (la fonte primaria
     del "Continua"). Gli slot manuali sono espliciti, niente
     reconcile silenzioso su quelli.
     ---------------------------------------------------------- */
  function reconcileAtBoot() {
    if (!isEnabled()) return Promise.resolve({ action: 'disabled' });
    setStatus('syncing');
    const localMeta = localAutosaveMeta();
    /* timeout proprio per il boot (piu' breve, non blocca a lungo). */
    return Promise.race([
      pullRemote('autosave'),
      new Promise(function (_, rej) { setTimeout(function () { rej(new Error('boot-timeout')); }, CFG.BOOT_TIMEOUT_MS); })
    ]).then(function (remote) {
      const localTs = localMeta ? (localMeta.ts || 0) : 0;
      const remoteTs = remote ? new Date(remote.updated_at).getTime() : 0;

      /* Nessun dato da nessuna parte: nulla da fare. */
      if (!remote && !localMeta) { setStatus('ok'); return { action: 'empty' }; }

      /* Solo locale: push iniziale (es. primo lancio con cloud abilitato). */
      if (!remote && localMeta) {
        setStatus('syncing');
        return pushRemote('autosave', localMeta.payload, {})
          .then(function () { setStatus('ok'); return { action: 'pushed-initial' }; })
          .catch(function (err) { setStatus('error', String(err && err.message || err)); return { action: 'push-failed' }; });
      }

      /* Solo cloud: scarica e applica al locale (nuovo dispositivo). */
      if (remote && !localMeta) {
        writeLocalAutosave(remote);
        setStatus('ok');
        return { action: 'pulled-fresh', remote: remote };
      }

      /* Entrambi: piu' recente vince. */
      if (remoteTs > localTs) {
        const backup = backupLocalPayload(localMeta.payload, 'cloud-newer');
        writeLocalAutosave(remote);
        setStatus('ok');
        return { action: 'pulled-overwrote-local', backupFile: backup, remoteTs: remoteTs, localTs: localTs };
      }
      if (localTs > remoteTs) {
        return pushRemote('autosave', localMeta.payload, {})
          .then(function () { setStatus('ok'); return { action: 'pushed-local-newer', localTs: localTs, remoteTs: remoteTs }; })
          .catch(function (err) { setStatus('error', String(err && err.message || err)); return { action: 'push-failed' }; });
      }
      /* uguali */
      setStatus('ok');
      return { action: 'in-sync' };
    }).catch(function (err) {
      setStatus('error', String(err && err.message || err));
      return { action: 'offline', error: String(err && err.message || err) };
    });
  }

  /* ----------------------------------------------------------
     Esposizione namespace.
     ---------------------------------------------------------- */
  ORION.cloud = {
    CFG: CFG,
    STATE: STATE,
    isEnabled: isEnabled,
    setEnabled: setEnabled,
    onChange: onChange,
    schedulePush: schedulePush,
    pushNow: pushNow,
    pull: pull,
    list: list,
    del: del,
    reconcileAtBoot: reconcileAtBoot,
    backupLocalPayload: backupLocalPayload,
    localAutosaveMeta: localAutosaveMeta,
    localSlotMeta: localSlotMeta,
    writeLocalAutosave: writeLocalAutosave,
    writeLocalSlot: writeLocalSlot
  };
})(typeof window !== 'undefined' ? window : globalThis);
