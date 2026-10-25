// 小熊工作室 cloud sync: LINE sign-in (LIFF) + Supabase.
// Class and personal data (student names, contacts, rosters…) live only on the server and in this
// page's memory: nothing is written to the phone's storage. The app's own code still calls
// localStorage as before; for data keys those calls are answered from memory and mirrored to the server.
(function () {
  "use strict";
  const CFG = {
    supabaseUrl: "https://cwsxlfifpydxmmjsiwzg.supabase.co",
    supabaseKey: "sb_publishable_2e3Qb6cB7J70m4d7JSCKlg_HVQNsOS7",
    liffId: "2012187193-uL27Ayag",
    oaBasicId: "@773tdrjx", // 熊班 official account
    vapidKey: "BM2rjrxMX-qgEIz8rnOkN_gC1aywURPYw9tZ0Jdoo08sjg0sSwAQMCRnyKQlIXkxjMmsbxARBMVO02_IZG1sYHY", // phone notifications
  };
  // Data the whole class shares vs. data that belongs to one teacher.
  const SHARED = ["bear_student_records", "bear_forms", "bear_fund_records", "bear_fund_types", "bear_afterschool", "bear_bus_routes", "bear_bus_riders", "bear_attendance", "bear_teacher_map", "bear_roster_rows", "bear_sub_records", "bear_routine", "bear_motor_days", "bear_motor_plans", "bear_lessons", "bear_lesson_themes"];
  const PERSONAL = ["bear_tasks", "bear_trainings", "bear_training_cycle", "bear_schedules", "bear_profile", "bear_chores", "bear_notify_prefs", "bear_file_note", "bear_cal_events", "bear_cal_plans"];
  // Read before LINE's SDK tidies up the address bar: set when the login was started from the home-screen app.
  const BOOT_PAIR = (() => {
    // LINE may wrap our address several times (liff.state, liffRedirectUri…), so unwrap and search all of it.
    let t = location.search + location.hash, v = "";
    for (let i = 0; i < 4 && !v; i++) { v = ((/pair(?:=|%3D)([A-Za-z0-9]{24,64})/i.exec(t) || [])[1]) || ""; try { t = decodeURIComponent(t); } catch { break; } }
    try { if (v) sessionStorage.setItem("bear_boot_pair", v); else v = sessionStorage.getItem("bear_boot_pair") || ""; } catch {}
    return v;
  })();
  const LS = window.localStorage;
  const rawSet = Storage.prototype.setItem;
  const rawGet = Storage.prototype.getItem;
  const rawRemove = Storage.prototype.removeItem;
  // ---------- memory-only store for data ----------
  const MEM = new Map();
  const isData = (k) => SHARED.includes(k) || PERSONAL.includes(k) || k === "bear_cloud_meta" || k === "bear_team";
  // Copies left on this device by older versions: load them into memory (so unsynced edits still reach
  // the server), then delete them from the device once the server has everything.
  const LEGACY = [];
  for (const k of [...SHARED, ...PERSONAL, "bear_cloud_meta", "bear_team"]) { const v = rawGet.call(LS, k); if (v != null) { MEM.set(k, v); LEGACY.push(k); } }
  function wipeLegacy() { LEGACY.splice(0).forEach((k) => { try { rawRemove.call(LS, k); } catch {} }); }
  const meta = () => { let m = {}; try { m = JSON.parse(MEM.get("bear_cloud_meta") || "{}") || {}; } catch {} try { const w = JSON.parse(rawGet.call(LS, "bear_cloud_ws") || "null"); if (w && !("ws" in m)) m.ws = w; } catch {} return m; };
  const saveMeta = (m) => { MEM.set("bear_cloud_meta", JSON.stringify(m)); try { rawSet.call(LS, "bear_cloud_ws", JSON.stringify(m.ws ? { id: m.ws.id, name: m.ws.name } : null)); } catch {} };
  const toast = (m) => (window.showToast ? window.showToast(m) : console.log(m));
  const escH = (s) => (window.esc ? window.esc(s) : String(s ?? ""));

  let sb = null, user = null, ws = null, channel = null, muted = false;
  const timers = {}, inflight = {};

  // ---------- storage hook ----------
  const KEEP_ALWAYS = ["bear_cloud_meta", "bear_cloud_auth", "bear_login_msg"];
  let guest = !rawGet.call(LS, "bear_cloud_auth");
  Storage.prototype.setItem = function (k, v) {
    if (this === LS && isData(k)) {
      if (!muted && user && !guest && isRO() && (SHARED.includes(k) || PERSONAL.includes(k)) && !["bear_notify_prefs", "bear_profile"].includes(k)) {
        if (!roWarned) { roWarned = true; setTimeout(() => { roWarned = false; }, 4000); toast("方案已到期，目前是唯讀模式，修改不會儲存。續約後就能繼續使用"); }
        return;
      }
      MEM.set(k, String(v));
      if (!muted && user && !guest && (SHARED.includes(k) || PERSONAL.includes(k))) queuePush(k);
      return;
    }
    rawSet.call(this, k, v);
  };
  Storage.prototype.getItem = function (k) { if (this === LS && isData(k)) return MEM.has(k) ? MEM.get(k) : null; return rawGet.call(this, k); };
  Storage.prototype.removeItem = function (k) { if (this === LS && isData(k)) { MEM.delete(k); return; } return rawRemove.call(this, k); };
  function writeLocal(k, value) { MEM.set(k, typeof value === "string" ? value : JSON.stringify(value)); }
  function readLocal(k) { const v = MEM.get(k); if (v == null) return undefined; try { return JSON.parse(v); } catch { return v; } }
  // ---------- the app itself starts only after its data has arrived from the server ----------
  let appStarted = false;
  function startApp() {
    if (appStarted || window.__bearStarted) { appStarted = true; return; } appStarted = true; window.__bearStarted = true;
    const src = document.getElementById("bearApp");
    if (src) { const sc = document.createElement("script"); sc.textContent = src.textContent; document.body.appendChild(sc); }
    const ld = document.getElementById("bearLoading"); if (ld) ld.remove();
  }

  // ---------- 3-way merge so two teachers editing at once don't lose each other's changes ----------
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  function merge(base, local, remote) {
    if (same(local, base)) return remote;
    if (same(remote, base)) return local;
    const isIdList = (x) => Array.isArray(x) && x.every((o) => o && typeof o === "object" && "id" in o);
    if (isIdList(local) && isIdList(remote) && (base == null || isIdList(base))) {
      const B = new Map((base || []).map((o) => [o.id, o])), L = new Map(local.map((o) => [o.id, o])), R = new Map(remote.map((o) => [o.id, o]));
      const out = [];
      const pick = (id) => {
        const inB = B.has(id), inL = L.has(id), inR = R.has(id);
        const localChanged = inL ? !inB || !same(L.get(id), B.get(id)) : inB; // edited, added or deleted here
        if (localChanged) return inL ? L.get(id) : null;
        return inR ? R.get(id) : null;
      };
      const seen = new Set();
      [...remote, ...local].forEach((o) => { if (seen.has(o.id)) return; seen.add(o.id); const v = pick(o.id); if (v) out.push(v); });
      return out;
    }
    if (local && remote && typeof local === "object" && typeof remote === "object" && !Array.isArray(local) && !Array.isArray(remote)) {
      const b = base && typeof base === "object" ? base : {}, out = { ...remote };
      Object.keys({ ...local, ...b }).forEach((k) => {
        if (!same(local[k], b[k])) { if (k in local) out[k] = local[k]; else delete out[k]; }
      });
      return out;
    }
    return local; // plain values: the latest edit wins
  }

  // ---------- push ----------
  function queuePush(k) {
    const m = meta(); m.dirty = { ...(m.dirty || {}), [k]: true }; saveMeta(m);
    clearTimeout(timers[k]); timers[k] = setTimeout(() => push(k), 700);
    setStatus("儲存中…");
  }
  async function push(k) {
    if (!user) return;
    if (inflight[k]) { queuePush(k); return; }
    inflight[k] = true;
    try {
      const value = readLocal(k);
      if (value === undefined) return;
      if (PERSONAL.includes(k) || !ws) { // not in a class yet: class data is kept in the teacher's own cloud space
        const { error } = await sb.from("personal_data").upsert({ user_id: user.id, key: k, value, updated_at: new Date().toISOString() });
        if (error) throw error;
      } else {
        const m = meta(), vers = m.vers || {}, bases = m.bases || {};
        let attempt = 0, toSave = value;
        while (attempt++ < 4) {
          const { data, error } = await sb.rpc("put_shared", { p_ws: ws.id, p_key: k, p_value: toSave, p_base: vers[ws.id + "|" + k] || 0 });
          if (error) throw error;
          const r = data[0];
          if (r.ok) { vers[ws.id + "|" + k] = r.version; bases[ws.id + "|" + k] = toSave; break; }
          toSave = merge(bases[ws.id + "|" + k], toSave, r.value);
          vers[ws.id + "|" + k] = r.version; bases[ws.id + "|" + k] = r.value;
          writeLocal(k, toSave); needsRefresh("班上其他老師剛好也在修改，已自動合併");
        }
        m.vers = vers; m.bases = bases; saveMeta(m);
      }
      const m2 = meta(); if (m2.dirty) delete m2.dirty[k]; saveMeta(m2);
      setStatus("已同步 " + new Date().toTimeString().slice(0, 5));
    } catch (e) {
      console.error(e);
      setStatus("暫時無法同步，連上網路後會自動重試");
    } finally { inflight[k] = false; }
  }
  async function flushDirty() { const d = meta().dirty || {}; for (const k of Object.keys(d)) await push(k); }

  // ---------- pull ----------
  async function pull({ reloadIfChanged = true } = {}) {
    if (!user) return;
    let changed = false;
    const { data: pd, error: pe } = await sb.from("personal_data").select("key,value");
    if (pe) throw pe;
    const cloudP = new Map((pd || []).map((r) => [r.key, r.value]));
    for (const k of ws ? PERSONAL : [...PERSONAL, ...SHARED]) {
      if (cloudP.has(k)) { if (!same(readLocal(k), cloudP.get(k))) { writeLocal(k, cloudP.get(k)); changed = true; } }
      else if (readLocal(k) !== undefined) queuePush(k); // first sign-in: upload what this device has
    }
    if (ws) {
      const { data: sd, error: se } = await sb.from("shared_data").select("key,value,version").eq("workspace_id", ws.id);
      if (se) throw se;
      const m = meta(); m.vers = m.vers || {}; m.bases = m.bases || {};
      const cloudS = new Map((sd || []).map((r) => [r.key, r]));
      for (const k of SHARED) {
        const r = cloudS.get(k), id = ws.id + "|" + k;
        if (r) {
          const local = readLocal(k), dirty = m.dirty && m.dirty[k];
          const val = dirty && m.bases[id] !== undefined ? merge(m.bases[id], local, r.value) : r.value;
          m.vers[id] = r.version; m.bases[id] = r.value;
          if (!same(local, val)) { writeLocal(k, val); changed = true; }
          if (dirty && !same(val, r.value)) setTimeout(() => queuePush(k), 0);
        } else if (readLocal(k) !== undefined && m.uploadLocalTo === ws.id) queuePush(k);
      }
      saveMeta(m);
    }
    setStatus("已同步 " + new Date().toTimeString().slice(0, 5));
    if (changed && reloadIfChanged) reloadApp();
    return changed;
  }
  async function reloadApp() {
    try { sessionStorage.setItem("bear_cloud_reloaded", String(Date.now())); } catch {}
    try { await Promise.race([flushDirty(), new Promise((r) => setTimeout(r, 3000))]); } catch {}
    location.reload();
  }

  // ---------- realtime ----------
  function subscribe() {
    if (channel) { sb.removeChannel(channel); channel = null; }
    if (!ws) return;
    channel = sb.channel("ws-" + ws.id).on("postgres_changes", { event: "*", schema: "public", table: "shared_data", filter: "workspace_id=eq." + ws.id }, (p) => {
      const r = p.new; if (!r || !r.key || r.updated_by === user.id) return;
      const m = meta(), id = ws.id + "|" + r.key; m.vers = m.vers || {}; m.bases = m.bases || {};
      if ((m.vers[id] || 0) >= r.version) return;
      const local = readLocal(r.key), dirty = m.dirty && m.dirty[r.key];
      const val = dirty && m.bases[id] !== undefined ? merge(m.bases[id], local, r.value) : r.value;
      m.vers[id] = r.version; m.bases[id] = r.value; saveMeta(m);
      writeLocal(r.key, val);
      if (dirty) setTimeout(() => queuePush(r.key), 0);
      needsRefresh("同班老師更新了資料");
    }).subscribe();
  }
  function needsRefresh(msg) {
    let bar = document.getElementById("cloudBar");
    if (!bar) {
      bar = document.createElement("div"); bar.id = "cloudBar"; bar.className = "cloud-bar";
      bar.innerHTML = `<span></span><button type="button">重新整理</button>`;
      bar.querySelector("button").onclick = () => reloadApp();
      document.body.appendChild(bar);
    }
    bar.querySelector("span").textContent = msg + "，按這裡看最新內容";
    bar.hidden = false;
  }

  // ---------- classes (workspaces) ----------
  async function loadWorkspaces() {
    const { data, error } = await sb.from("workspace_members").select("role, status, workspaces(id,name,invite_code)").eq("user_id", user.id);
    if (error) throw error;
    return (data || []).filter((r) => r.workspaces).map((r) => ({ ...r.workspaces, role: r.role, status: r.status || "active", invite_code: r.status === "pending" ? "" : r.workspaces.invite_code }));
  }
  async function chooseWorkspace(w, { upload = false } = {}) {
    // Leaving or switching classes: never carry one class's data (student names…) into another space.
    if (ws && (!w || w.id !== ws.id) && !upload) SHARED.forEach((k) => MEM.delete(k));
    ws = w || null;
    const m = meta(); m.ws = ws ? { id: ws.id, name: ws.name } : null; if (upload && ws) m.uploadLocalTo = ws.id; saveMeta(m);
    subscribe();
    await loadAccess(); applyAccess();
    if (ws) { const changed = await pull({ reloadIfChanged: false }); if (upload) for (const k of SHARED) if (readLocal(k) !== undefined) await push(k); if (changed) reloadApp(); }
    renderCloudUI();
    renderAppCards();
    renderPairCodeBox();
  }

  // ---------- LINE sign-in ----------
  async function loadScript(src, ready) { if (ready()) return; await new Promise((res, rej) => { const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = () => rej(new Error("無法載入 " + src)); document.head.appendChild(s); }); }
  async function initLiff() {
    if (!CFG.liffId) return false;
    await loadScript("https://static.line-scdn.net/liff/edge/2/sdk.js", () => window.liff);
    await liff.init({ liffId: CFG.liffId });
    return true;
  }
  async function exchange(idToken) {
    if (!idToken) throw new Error("LINE 沒有給登入證明（ID token），請確認 LIFF 的 Scopes 有勾 openid");
    report("步驟 2／3：LINE 登入完成，正在建立你的帳號…");
    // Started from the home-screen app but LINE brought us back to Safari: hand the login to the app.
    const pair = BOOT_PAIR;
    const handOff = /^[A-Za-z0-9]{24,64}$/.test(pair || "") && !myPairs().includes(pair);
    const res = await fetch(CFG.supabaseUrl + "/functions/v1/line-auth", { method: "POST", headers: { "Content-Type": "application/json", apikey: CFG.supabaseKey }, body: JSON.stringify(handOff ? { idToken, pair } : { idToken }) });
    const body = await res.json();
    if (res.status === 401 && window.liff && !sessionStorage.getItem("bear_login_retry")) {
      // LINE's proof of login was too old: sign out of LINE here and log in again once.
      try { sessionStorage.setItem("bear_login_retry", "1"); } catch {}
      report("LINE 登入需要重新確認，正在重新連到 LINE…");
      try { liff.logout(); } catch {}
      liff.login({ redirectUri: location.origin + location.pathname + (handOff ? "?pair=" + pair : (isApp() ? "?pair=" + currentPair() : "")) });
      return;
    }
    try { sessionStorage.removeItem("bear_login_retry"); sessionStorage.removeItem("bear_boot_pair"); } catch {}
    if (!res.ok) throw new Error(body.error || "登入失敗");
    if (body.paired) {
      report("LINE 登入完成！請回到手機主畫面的「小熊工作室」App，它會自動登入。");
      history.replaceState(null, "", location.pathname);
      const o = document.createElement("div");
      o.style.cssText = "position:fixed;inset:0;z-index:999;background:#fbf6f0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:32px;text-align:center;color:#5d4b44";
      o.innerHTML = `<img src="/icon-192.png" width="96" height="96" alt="" style="border-radius:22px;box-shadow:0 8px 24px #8264511f"><h2 style="margin:6px 0 0;font-size:21px">LINE 登入完成 ♡</h2><p style="margin:0;font-size:14px;line-height:1.8;color:#8d786d">現在可以關掉這個瀏覽器，<br>回到手機主畫面，打開<b>小熊工作室</b> App，<br>它會自動幫你登入。</p>${body.code ? `<div style="margin-top:6px;font-size:12px;color:#8d786d">如果 App 沒有自動登入，在 App 的登入頁輸入這組登入碼：</div><div style="font-size:34px;font-weight:800;letter-spacing:8px;color:#a66f72;background:#f6e9e5;border-radius:16px;padding:10px 18px">${body.code}</div><div style="font-size:11px;color:#a39287">10 分鐘內有效</div>` : ""}<p style="margin:8px 0 0;font-size:12px;color:#a39287">只有第一次需要這樣，之後打開 App 都會保持登入。</p>`;
      document.body.appendChild(o);
      return;
    }
    clearPairs();
    return finishLogin(body);
  }
  function idTokenStale() { try { const d = liff.getDecodedIDToken(); return !d || !d.exp || d.exp * 1000 < Date.now() + 60e3; } catch { return true; } }
  function newNonce() { const a = new Uint8Array(24); crypto.getRandomValues(a); return Array.from(a, (b) => "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"[b % 62]).join(""); }
  // Hand-off codes this app is waiting on (kept for 15 minutes; tapping login again reuses the latest one).
  const PAIR_MS = 15 * 60e3;
  function pairList() { try { return (JSON.parse(rawGet.call(LS, "bear_cloud_pairs") || "[]") || []).filter((p) => p && p.n && Date.now() - p.t < PAIR_MS); } catch { return []; } }
  const myPairs = () => pairList().map((p) => p.n);
  function currentPair() {
    const l = pairList(), last = l[l.length - 1];
    if (last && Date.now() - last.t < 10 * 60e3) return last.n;
    const n = newNonce(); l.push({ n, t: Date.now() }); rawSet.call(LS, "bear_cloud_pairs", JSON.stringify(l.slice(-6))); return n;
  }
  function clearPairs() { try { LS.removeItem("bear_cloud_pairs"); LS.removeItem("bear_cloud_pair"); } catch {} }
  let pairTimer = null;
  function watchPairs() {
    claimPairedLogin();
    if (pairTimer) return;
    const started = Date.now();
    pairTimer = setInterval(() => { if (user || !myPairs().length || Date.now() - started > PAIR_MS) { clearInterval(pairTimer); pairTimer = null; return; } if (!document.hidden) claimPairedLogin(); }, 3000);
  }
  function renderPairCodeBox() {
    let box = document.getElementById("pairCodeBox");
    const anchor = document.getElementById("cloudAccount");
    if (!anchor) return;
    if (!box) { box = document.createElement("div"); box.id = "pairCodeBox"; anchor.after(box); }
    box.hidden = !(isApp() && !user);
    if (box.hidden) return;
    box.innerHTML = `<div style="background:#fbf3ee;border-radius:14px;padding:12px;margin-top:12px"><strong style="font-size:12px;color:#6e5d54">已經在 Safari 登入了？</strong><p class="small-note" style="margin:4px 0 8px;line-height:1.6">輸入 Safari 畫面上的 6 位數登入碼：</p><div style="display:flex;gap:8px"><input id="pairCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="例如 123456" style="flex:1;min-width:0;border:1px solid #eadbd1;border-radius:12px;padding:10px 12px;font-size:16px;letter-spacing:3px;background:#fffdf9"><button type="button" class="primary" id="pairCodeGo" style="width:auto;padding:0 18px;margin:0">登入</button></div></div>`;
    box.querySelector("#pairCodeGo").onclick = async () => {
      const v = box.querySelector("#pairCode").value.replace(/\D/g, "");
      if (v.length !== 6) return toast("請輸入 6 位數字");
      try {
        const res = await fetch(CFG.supabaseUrl + "/functions/v1/line-auth", { method: "POST", headers: { "Content-Type": "application/json", apikey: CFG.supabaseKey }, body: JSON.stringify({ code: v }) });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || !body.token_hash) return toast(body.error || "登入失敗");
        clearPairs(); await finishLogin(body); box.hidden = true;
      } catch (e) { toast("登入失敗：" + (e.message || e)); }
    };
  }
  let claiming = false;
  async function claimPairedLogin() {
    const n = myPairs();
    if (!n.length || user || claiming || !sb) return;
    claiming = true;
    try {
      const res = await fetch(CFG.supabaseUrl + "/functions/v1/line-auth", { method: "POST", headers: { "Content-Type": "application/json", apikey: CFG.supabaseKey }, body: JSON.stringify({ claim: n }) });
      const body = await res.json().catch(() => ({}));
      if (body.token_hash) { clearPairs(); report("步驟 3／3：收到 LINE 登入，正在登入…"); await finishLogin(body); }
    } catch (e) { console.warn(e); } finally { claiming = false; }
  }
  async function finishLogin({ token_hash }) {
    const { data, error } = await sb.auth.verifyOtp({ token_hash, type: "magiclink" });
    if (error) throw error;
    user = data.user;
    setGuest(false);
    report("步驟 3／3：登入成功");
    try { sessionStorage.removeItem("bear_login_msg"); } catch {}
    await afterSignIn(true);
  }
  async function startLogin() {
    try {
      if (!CFG.liffId) { toast("LINE 登入還在設定中，設定好之後就能用了"); return; }
      report("步驟 1／3：正在連到 LINE…");
      await initLiff();
      // A LINE login left over from earlier can hold an expired ID token: start a fresh login instead.
      if (liff.isLoggedIn() && idTokenStale()) { try { liff.logout(); } catch {} }
      if (!liff.isLoggedIn()) {
        report("步驟 1／3：前往 LINE 登入頁…");
        let redirectUri = location.origin + location.pathname;
        if (isApp()) { redirectUri += "?pair=" + currentPair(); watchPairs(); report("登入完成後，如果停在 Safari，請回到這個 App，它會自動登入。"); }
        liff.login({ redirectUri }); return;
      }
      await exchange(liff.getIDToken());
    } catch (e) { console.error(e); report("登入失敗：" + (e.message || e)); toast("登入失敗：" + (e.message || e)); }
  }
  async function signOut() {
    await sb.auth.signOut(); user = null; ws = null; if (channel) sb.removeChannel(channel);
    try { if (window.liff && liff.isLoggedIn && liff.isLoggedIn()) liff.logout(); } catch {}
    MEM.clear(); wipeLegacy();
    const drop = []; for (let i = 0; i < LS.length; i++) { const k = LS.key(i); if (k && k.startsWith("bear_") && !["bear_hol_cache", "bear_ind_age"].includes(k)) drop.push(k); }
    drop.forEach((k) => { try { rawRemove.call(LS, k); } catch {} });
    toast("已登出，你的資料都安全存在雲端");
    setTimeout(() => location.reload(), 900);
  }
  async function afterSignIn(fresh) {
    const list = await loadWorkspaces();
    const act = list.filter((w) => w.status !== "pending"), saved = meta().ws, pickWs = act.find((w) => saved && w.id === saved.id) || (act.length === 1 ? act[0] : null);
    ws = pickWs; const m = meta(); m.ws = ws ? { id: ws.id, name: ws.name } : null; saveMeta(m);
    subscribe();
    renderCloudUI(list);
    await flushDirty();
    const recently = Number(sessionStorage.getItem("bear_cloud_reloaded") || 0) > Date.now() - 4000;
    await pull({ reloadIfChanged: !recently });
    if (fresh) toast(`歡迎，${escH(user.user_metadata?.name || "老師")}！資料會自動同步`);
  }

  // ---------- guest mode: only show what the app can do ----------
  const OPEN_VIEWS = ["home", "menu", "login"];
  let baseSwitch = null;
  function setGuest(on) {
    guest = on;
    document.body.classList.toggle("guest", on);
    const cv = typeof currentView !== "undefined" ? currentView : "home"; if (on && !OPEN_VIEWS.includes(cv) && baseSwitch) baseSwitch("home");
  }
  function installGuestUI() {
    baseSwitch = window.switchView;
    window.switchView = function (v) {
      if (guest && !OPEN_VIEWS.includes(v)) { toast("請先用 LINE 登入，登入後就能使用這個功能"); return baseSwitch("login"); }
      const f = FEATURE_OF_VIEW[v]; if (f && access && access.state !== "guest" && !hasFeature(f)) { toast(`目前的方案沒有包含「${FEATURE_NAMES[f]}」，可以看看其他方案`); return openPlans(); }
      return baseSwitch(v);
    };
    const css = document.createElement("style");
    css.textContent = `body.guest #fab{display:none!important}#guestIntro,#guestMenuNote{display:none}body.guest #guestIntro,body.guest #guestMenuNote{display:block}body.guest #view-home>:not(#guestIntro),body.guest #view-menu .menu-tile{pointer-events:none;user-select:none;-webkit-user-select:none}body.guest #view-home input,body.guest #view-home button:not(#guestIntro *){pointer-events:none}`;
    document.head.appendChild(css);
    const hello = document.querySelector("#view-home .hello"), grid = document.querySelector("#view-menu .menu-grid");
    if (hello && !document.getElementById("guestIntro")) {
      const intro = document.createElement("div");
      intro.id = "guestIntro"; intro.className = "motor-warn"; intro.style.margin = "14px 0 0";
      intro.innerHTML = `還沒登入，只能先看看有哪些功能。<button type="button" class="link-btn" id="guestLogin" style="font-size:12px">用 LINE 登入</button>`;
      hello.after(intro);
      intro.querySelector("#guestLogin").onclick = () => startLogin();
    }
    if (grid && !document.getElementById("guestMenuNote")) {
      const note = document.createElement("div");
      note.id = "guestMenuNote"; note.className = "motor-warn"; note.style.marginTop = "0";
      note.innerHTML = `還沒登入，只能先看看有哪些功能。<button type="button" class="link-btn" style="font-size:12px">用 LINE 登入</button>`;
      note.querySelector("button").onclick = () => startLogin();
      grid.before(note);
    }
    setGuest(guest);
  }

  // ---------- UI on the 登入 and 班級共享 pages ----------
  let lastList = null;
  function setStatus(t) { const el = document.getElementById("cloudStatus"); if (el) el.textContent = t; }
  function report(t) { try { sessionStorage.setItem("bear_login_msg", t); } catch {} setStatus(t); console.log("[login]", t); }
  async function renderCloudUI(list) {
    if (list) lastList = list;
    const box = document.getElementById("cloudAccount"), team = document.getElementById("cloudTeam");
    if (!box || !team) return;
    const lb = document.querySelector(".line-login"); if (lb) lb.style.display = user ? "none" : "flex";
    ["backupCard", "profileCard", "inviteCard"].forEach((id) => { const el = document.getElementById(id); if (el) el.hidden = !user; });
    const perks = document.getElementById("loginPerks"); if (perks) perks.hidden = !!user;
    if (!user) {
      box.innerHTML = `<p class="small-note" style="line-height:1.7;margin:0">登入後，資料會存到雲端，換手機或電腦也看得到；同班老師加入同一個班級後會自動同步。</p><p class="small-note" id="cloudStatus" style="margin:8px 0 0;color:#a86f70;line-height:1.6;overflow-wrap:anywhere"></p>`;
      const last = sessionStorage.getItem("bear_login_msg"); if (last) setStatus(last);
      team.innerHTML = `<div class="empty">請先到「登入」頁用 LINE 登入，才能建立或加入班級。</div>`;
      return;
    }
    const name = user.user_metadata?.name || "老師", pic = user.user_metadata?.picture || "";
    box.innerHTML = `<div class="cloud-me">${pic ? `<img src="${escH(pic)}" alt="" width="44" height="44">` : ""}<div><b>${escH(name)}</b><small>已用 LINE 登入${ws ? ` · 目前班級：${escH(ws.name)}` : " · 還沒加入班級"}</small></div></div><p class="small-note" id="cloudStatus" style="margin:8px 0 0"></p><button type="button" class="outline-btn" id="cloudSignOut" style="margin-top:10px">登出</button>`;
    document.getElementById("cloudSignOut").onclick = signOut;
    const ls = lastList || (await loadWorkspaces());
    lastList = ls;
    let members = [];
    if (ws) { const { data } = await sb.from("workspace_members").select("role, user_id, status").eq("workspace_id", ws.id); const ids = (data || []).map((m) => m.user_id); const { data: ps } = ids.length ? await sb.from("profiles").select("id, display_name").in("id", ids) : { data: [] }; const nm = new Map((ps || []).map((p) => [p.id, p.display_name])); members = (data || []).map((m) => ({ ...m, profiles: { display_name: nm.get(m.user_id) } })); }
    team.innerHTML = `${ls.length ? `<div class="field"><label>目前使用的班級</label><select id="cloudWsSel">${ls.filter((w) => w.status !== "pending").map((w) => `<option value="${w.id}" ${ws && w.id === ws.id ? "selected" : ""}>${escH(w.name)}${w.role === "owner" ? "（建立者）" : ""}</option>`).join("")}<option value="">（不使用班級）</option></select></div>` : ""}
      ${ws ? `<div class="cloud-code"><small>邀請碼（給同班老師輸入）</small><b>${escH(ls.find((w) => w.id === ws.id)?.invite_code || "")}</b><div class="rt-actions"><button type="button" class="outline-btn" id="cloudCopy">複製邀請碼</button>${ls.find((w) => w.id === ws.id)?.role === "owner" ? `<button type="button" class="outline-btn" id="cloudRenew">換一組新的邀請碼</button>` : ""}<button type="button" class="outline-btn" id="cloudHist">修改紀錄</button><button type="button" class="outline-btn" id="cloudLeave">退出這個班級</button></div></div><div id="cloudHistBox" class="lesson-card hist-box" hidden></div>${(() => { const isOwner = ls.find((w) => w.id === ws.id)?.role === "owner", pend = members.filter((m) => m.status === "pending"), act = members.filter((m) => m.status !== "pending");
        return `${pend.length && isOwner ? `<div class="motor-warn" style="margin:10px 0 4px"><b>有 ${pend.length} 位老師申請加入</b>，核准後對方才看得到班級資料（包含學生個資）。請確認是同班老師再核准。${pend.map((m) => `<div class="cloud-pend"><span>${escH(m.profiles?.display_name || "老師")}</span><button type="button" class="outline-btn" data-approve="${m.user_id}">核准</button><button type="button" class="outline-btn" data-reject="${m.user_id}">拒絕</button></div>`).join("")}</div>` : ""}<div class="small-note" style="margin:10px 0 4px">班級成員（${act.length}）</div><div class="fm-chips">${act.map((m) => `<span class="tag ${m.role === "owner" ? "" : "green"}">${escH(m.profiles?.display_name || "老師")}${m.role === "owner" ? " · 建立者" : ""}${isOwner && m.role !== "owner" ? ` <button type="button" class="cloud-x" data-reject="${m.user_id}" aria-label="移出班級">×</button>` : ""}</span>`).join("")}</div>`; })()}` : ""}
      ${ls.filter((w) => w.status === "pending").map((w) => `<div class="motor-warn" style="margin-top:10px">已申請加入「${escH(w.name)}」，等班級建立者核准中。核准後重新打開 App 就能看到班級資料。</div>`).join("")}
      <div id="cloudLeaveConfirm" class="motor-warn" hidden></div>`;
    team.querySelectorAll("[data-approve]").forEach((b) => b.onclick = async () => { const { error } = await sb.rpc("approve_member", { p_ws: ws.id, p_user: b.dataset.approve }); if (error) return toast(/seats_full/.test(error.message) ? `班級人數已滿（${access?.seats || 3} 位老師），需要增加人數請聯絡管理者開通` : /plan_no_team/.test(error.message) ? "目前的方案不包含班級共享" : /plan_readonly/.test(error.message) ? "方案已到期，續約後才能核准新成員" : "核准失敗：" + error.message); toast("已核准，對方重新打開 App 就能看到班級資料"); renderCloudUI(); });
    team.querySelectorAll("[data-reject]").forEach((b) => b.onclick = async () => { if (!confirm("確定要把這位老師移出班級嗎？對方將看不到班級資料。")) return; const { error } = await sb.from("workspace_members").delete().eq("workspace_id", ws.id).eq("user_id", b.dataset.reject); if (error) return toast("移除失敗：" + error.message); toast("已移出班級"); renderCloudUI(); });
    const hb = document.getElementById("cloudHist"); if (hb) hb.onclick = () => openHistory(document.getElementById("cloudHistBox"));
    const sel = document.getElementById("cloudWsSel");
    if (sel) sel.onchange = () => chooseWorkspace(ls.find((w) => w.id === sel.value) || null);
    const copy = document.getElementById("cloudCopy");
    if (copy) copy.onclick = () => { const code = ls.find((w) => w.id === ws.id)?.invite_code || ""; navigator.clipboard?.writeText(code).then(() => toast("邀請碼已複製：" + code)).catch(() => toast("邀請碼：" + code)); };
    const renew = document.getElementById("cloudRenew");
    if (renew) renew.onclick = async () => { const { data, error } = await sb.rpc("renew_invite_code", { p_ws: ws.id }); if (error) return toast("換邀請碼失敗：" + error.message); lastList = await loadWorkspaces(); renderCloudUI(); toast("新的邀請碼：" + data + "，舊的已經不能用了"); };
    const leave = document.getElementById("cloudLeave");
    if (leave) leave.onclick = () => {
      const c = document.getElementById("cloudLeaveConfirm");
      c.hidden = false;
      c.innerHTML = `確定要退出「${escH(ws.name)}」嗎？退出後就看不到這個班級的共享資料。<div class="rt-actions"><button type="button" class="outline-btn" id="cloudLeaveNo">取消</button><button type="button" class="outline-btn" id="cloudLeaveYes">確定退出</button></div>`;
      document.getElementById("cloudLeaveNo").onclick = () => { c.hidden = true; };
      document.getElementById("cloudLeaveYes").onclick = async () => { await sb.from("workspace_members").delete().eq("workspace_id", ws.id).eq("user_id", user.id); lastList = await loadWorkspaces(); await chooseWorkspace(null); toast("已退出班級"); };
    };
  }
  async function createClass() {
    if (!user) { toast("請先用 LINE 登入"); window.switchView && switchView("login"); return; }
    const name = (document.getElementById("teamName")?.value || "").trim();
    if (!name) { toast("請先輸入班級名稱"); return; }
    const { data, error } = await sb.rpc("create_workspace", { p_name: name });
    if (error) return toast(/plan_no_team/.test(error.message) ? "目前的方案不包含「班級共享」，升級成班級協作版就能邀請同班老師" : /plan_readonly/.test(error.message) ? "方案已到期，續約後才能建立班級" : "建立失敗：" + error.message);
    lastList = await loadWorkspaces();
    await chooseWorkspace(lastList.find((w) => w.id === data.id), { upload: true });
    toast(`已建立「${escH(name)}」，邀請碼：${data.invite_code}`);
  }
  async function joinClass() {
    if (!user) { toast("請先用 LINE 登入"); window.switchView && switchView("login"); return; }
    const code = (document.getElementById("joinCode")?.value || "").trim();
    if (!code) { toast("請輸入邀請碼"); return; }
    const { data, error } = await sb.rpc("join_workspace", { p_code: code });
    if (error) return toast("加入失敗：" + error.message);
    if (data?.error === "too_many") return toast("輸入錯誤太多次，請一小時後再試");
    if (data?.error) return toast("找不到這個邀請碼，請再確認一次");
    lastList = await loadWorkspaces();
    if (data.status === "pending") { renderCloudUI(lastList); return toast(`已送出加入「${escH(data.name)}」的申請，等班級建立者核准後就能看到班級資料`); }
    await chooseWorkspace(lastList.find((w) => w.id === data.id));
    toast(`已加入「${escH(data.name)}」，班級資料會自動同步`);
  }

  // ---------- AI reading of photos (Claude, via the ai-read function) ----------
  function toJpeg(src) {
    const w = src.naturalWidth || src.width, h = src.naturalHeight || src.height, sc = Math.min(1, 1600 / Math.max(w, h));
    const c = document.createElement("canvas"); c.width = Math.round(w * sc); c.height = Math.round(h * sc);
    const x = c.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height); x.drawImage(src, 0, 0, c.width, c.height);
    return { media_type: "image/jpeg", data: c.toDataURL("image/jpeg", 0.88).split(",")[1] };
  }
  async function pdfPages(buf, max = 4) {
    await loadLib(PDFJS_URL, () => window.pdfjsLib); pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise, out = [];
    for (let p = 1; p <= Math.min(pdf.numPages, max); p++) {
      const page = await pdf.getPage(p), vp = page.getViewport({ scale: 2 }), c = document.createElement("canvas");
      c.width = vp.width; c.height = vp.height; const cx = c.getContext("2d"); cx.fillStyle = "#fff"; cx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: cx, viewport: vp }).promise; out.push(c);
    }
    return out;
  }
  async function aiRead(kind, sources, context, say) {
    if (!user || !sb) throw new Error("請先登入");
    const images = sources.slice(0, 4).map(toJpeg);
    (say || (() => {}))("AI 正在讀圖，大約需要 20～60 秒，請稍等…");
    const { data } = await sb.auth.getSession();
    const res = await fetch(CFG.supabaseUrl + "/functions/v1/ai-read", { method: "POST", headers: { "Content-Type": "application/json", apikey: CFG.supabaseKey, Authorization: "Bearer " + data.session.access_token }, body: JSON.stringify({ kind, images, context, ws: ws ? ws.id : null }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.ok) { if (res.status === 402) setTimeout(() => toast(body.error), 50); throw new Error(body.error || "AI 讀圖失敗"); }
    if (body.points && access) { access.ai_left = body.points.left; renderPlanCard(); }
    (say || (() => {}))("AI 讀完了，請檢查下面的內容");
    return body.data;
  }
  // ---------- automatic updates: a newer version of the site is picked up when the app is opened ----------
  const APP_VER = (document.querySelector('meta[name="bear-version"]') || {}).content || "";
  let hiddenAt = 0;
  const busy = () => { const a = document.activeElement; return (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) || !!document.querySelector(".md-actions [data-act=confirm]:not(.hidden)"); };
  async function checkUpdate(reason) {
    try {
      const v = (await (await fetch("/version.txt?t=" + Date.now(), { cache: "no-store" })).text()).trim();
      if (!/^\d{6,}$/.test(v) || !APP_VER || v === APP_VER) return;
      let tried = ""; try { tried = sessionStorage.getItem("bear_upd") || ""; } catch {}
      if (tried === v) return; // already reloaded for this version; the server copy may still be catching up
      if (reason === "manual" || busy()) { needsRefresh("小熊工作室有新版本"); return; }
      try { sessionStorage.setItem("bear_upd", v); } catch {}
      location.replace(location.pathname + "?v=" + v);
    } catch {}
  }
  document.addEventListener("visibilitychange", () => { if (document.hidden) hiddenAt = Date.now(); else if (Date.now() - hiddenAt > 15000) checkUpdate("resume"); });
  setInterval(() => { if (!document.hidden) checkUpdate("manual"); }, 10 * 60e3);

  // ---------- home-screen app and phone notifications ----------
  const isApp = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const inLine = () => /\bLine\//i.test(navigator.userAgent);
  let installEvt = null, swReg = null;
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installEvt = e; renderAppCards(); });
  async function registerSW() {
    if (!("serviceWorker" in navigator)) return null;
    try { swReg = await navigator.serviceWorker.register("/sw.js"); } catch (e) { console.warn(e); }
    navigator.serviceWorker.addEventListener("message", (e) => { if (e.data?.type === "open-view" && e.data.view && window.switchView) switchView(e.data.view); });
    return swReg;
  }
  const b64u = (s) => { const p = "=".repeat((4 - (s.length % 4)) % 4), r = atob((s + p).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from(r, (c) => c.charCodeAt(0)); };
  async function pushState() {
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return isIOS() && !isApp() ? "needApp" : "unsupported";
    if (Notification.permission === "denied") return "denied";
    const reg = swReg || (await navigator.serviceWorker.getRegistration());
    const sub = reg && (await reg.pushManager.getSubscription());
    return sub ? "on" : "off";
  }
  async function enablePush(btn) {
    if (!user) { toast("請先用 LINE 登入"); return; }
    try {
      btn && (btn.disabled = true);
      const perm = await Notification.requestPermission();
      if (perm !== "granted") { toast("沒有允許通知。要開啟的話，請到手機「設定」→「通知」→「小熊工作室」打開"); return; }
      const reg = swReg || (await registerSW()) || (await navigator.serviceWorker.ready);
      const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64u(CFG.vapidKey) }));
      const j = sub.toJSON();
      const { error } = await sb.from("push_subs").upsert({ endpoint: j.endpoint, user_id: user.id, sub: j });
      if (error) throw error;
      const { data } = await sb.auth.getSession();
      await fetch(CFG.supabaseUrl + "/functions/v1/web-push", { method: "POST", headers: { "Content-Type": "application/json", apikey: CFG.supabaseKey, Authorization: "Bearer " + data.session.access_token }, body: JSON.stringify({ mode: "test" }) });
      toast("手機通知開好了 ♡");
    } catch (e) { console.error(e); toast("開啟通知失敗：" + (e.message || e)); }
    finally { btn && (btn.disabled = false); renderAppCards(); }
  }
  async function disablePush() {
    try {
      const reg = swReg || (await navigator.serviceWorker.getRegistration()), sub = reg && (await reg.pushManager.getSubscription());
      if (sub) { if (sb && user) await sb.from("push_subs").delete().eq("endpoint", sub.endpoint); await sub.unsubscribe(); }
      toast("這支手機不會再收到通知");
    } catch (e) { toast("關閉失敗：" + (e.message || e)); }
    renderAppCards();
  }
  async function renderAppCards() {
    const st = await pushState().catch(() => "unsupported");
    const steps = isIOS()
      ? (inLine() ? `<ol class="app-steps"><li>點右上角「⋯」→ 選「用預設瀏覽器開啟」（Safari）</li><li>在 Safari 點下方的分享按鈕 <b>⬆︎</b></li><li>往下滑，點「加入主畫面」→「新增」</li></ol>`
        : `<ol class="app-steps"><li>用 <b>Safari</b> 開這個網站（現在就是的話直接下一步）</li><li>點下方的分享按鈕 <b>⬆︎</b></li><li>往下滑，點「加入主畫面」→「新增」</li><li>之後從主畫面的小熊圖示打開，登入一次就會一直保持登入</li></ol>`)
      : installEvt ? `<button type="button" class="primary" data-app="install">安裝到手機主畫面</button>`
      : `<ol class="app-steps"><li>用 Chrome 開這個網站</li><li>點右上角「⋮」→「加到主畫面」或「安裝應用程式」</li></ol>`;
    const install = isApp() ? `<p class="small-note app-ok">✓ 你正在用主畫面的 App，登入會一直保持。</p>` : `<p class="small-note" style="line-height:1.7;margin:8px 0 4px">加到手機主畫面後，打開就像 App 一樣，不用每次找網址，也可以收到手機通知。</p>${steps}`;
    const push = !user ? `<p class="small-note" style="margin:10px 0 0">登入後就能開啟手機通知。</p>`
      : st === "on" ? `<p class="small-note app-ok">✓ 這支手機已開啟通知：同班老師更新班表、名冊、作息表等資料時會通知你。</p><div class="rt-actions"><button type="button" class="outline-btn" data-app="test">傳一則測試通知</button><button type="button" class="outline-btn" data-app="off">關閉這支手機的通知</button></div>`
      : st === "needApp" ? `<p class="small-note" style="margin:10px 0 0;line-height:1.7">iPhone 要先照上面的步驟加到主畫面，從主畫面打開後，才能開啟手機通知。</p>`
      : st === "denied" ? `<p class="small-note" style="margin:10px 0 0;line-height:1.7">通知被關掉了。請到手機「設定」→「通知」→「小熊工作室」把「允許通知」打開，再回來這裡。</p>`
      : st === "unsupported" ? `<p class="small-note" style="margin:10px 0 0">這個瀏覽器不支援手機通知，可以改用 LINE 通知（下方設定）。</p>`
      : `<button type="button" class="primary" data-app="on" style="margin-top:10px">開啟手機通知</button><p class="small-note" style="margin:6px 0 0;line-height:1.6">同班老師更新班表、名冊、作息表等資料時，手機會跳出通知。</p>`;
    for (const id of ["appCard", "appCardLogin"]) {
      const el = document.getElementById(id); if (!el) continue;
      if (id === "appCardLogin" && isApp() && st === "on") { el.hidden = true; continue; }
      el.hidden = false;
      el.innerHTML = `<div class="lesson-top"><div class="lesson-icon"><span class=illus-bear aria-hidden=true></span></div><div><h4>手機 App 與通知</h4><p>把小熊工作室放到手機主畫面，並開啟通知。</p></div></div>${install}${push}`;
      el.querySelectorAll("[data-app]").forEach((b) => b.onclick = async () => {
        const a = b.dataset.app;
        if (a === "on") enablePush(b);
        else if (a === "off") disablePush();
        else if (a === "install" && installEvt) { installEvt.prompt(); await installEvt.userChoice.catch(() => {}); installEvt = null; renderAppCards(); }
        else if (a === "test") { const { data } = await sb.auth.getSession(); const r = await fetch(CFG.supabaseUrl + "/functions/v1/web-push", { method: "POST", headers: { "Content-Type": "application/json", apikey: CFG.supabaseKey, Authorization: "Bearer " + data.session.access_token }, body: JSON.stringify({ mode: "test" }) }); const j = await r.json().catch(() => ({})); toast(r.ok ? "已傳出，看看手機通知 ♡" : "沒有傳出去：" + (j.error || "請稍後再試")); }
      });
    }
  }

  window.bearAI = { read: aiRead, pdfPages, get ready() { return !!user; } };

  // ---------- backup (moving data from the old desktop file) ----------
  function exportBackup() {
    const out = {};
    for (const [k, v] of MEM) if (k !== "bear_cloud_meta") out[k] = v;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify({ app: "little-bear-workroom", exportedAt: new Date().toISOString(), data: out })], { type: "application/json" }));
    a.download = `小熊工作室備份_${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    toast("備份檔已下載");
  }
  async function importBackup(file) {
    try {
      const j = JSON.parse(await file.text());
      if (!j || j.app !== "little-bear-workroom" || !j.data) throw new Error("這不是小熊工作室的備份檔");
      Object.entries(j.data).forEach(([k, v]) => { if (k.startsWith("bear_") && k !== "bear_cloud_meta") LS.setItem(k, v); });
      toast("備份已匯入，正在重新整理…");
      setTimeout(() => location.reload(), 1500);
    } catch (e) { toast("匯入失敗：" + (e.message || e)); }
  }

  // ---------- boot ----------
  // ---------- plan / subscription ----------
  let access = null, catalog = null, roWarned = false;
  const FEATURE_OF_VIEW = { funds: "funds", supplies: "supplies", forms: "forms", students: "students", roster: "roster", routine: "routine", chores: "chores", tasks: "tasks", schedule: "schedule", lessons: "lessons", motor: "motor", training: "training", calendar: "calendar", afterschool: "afterschool", bus: "bus", files: "indicators", team: "team", attendance: "attendance", logs: "logs" };
  const FEATURE_NAMES = { tasks: "待辦清單", schedule: "班表管理", lessons: "教案花園", training: "研習任務", calendar: "行事曆", chores: "例行公事", funds: "班級資金", supplies: "寶貝補給品", forms: "回條小幫手", students: "學生名冊", roster: "全園班表與代班", routine: "班級作息表", motor: "大肌肉活動", afterschool: "課後才藝", bus: "娃娃車名單", indicators: "幼兒學習指標", attendance: "出缺勤點名", logs: "週誌月報", team: "班級共享（多位老師）", ai: "AI 小幫手" };
  const isRO = () => !!(access && access.state === "readonly");
  const hasFeature = (f) => !access || access.state === "guest" || !access.features || access.features[f] !== false && (access.features[f] === true || access.features[f] === undefined);
  async function loadAccess() { if (!sb || !user) return null; try { const { data, error } = await sb.rpc("my_access", { p_ws: ws ? ws.id : null }); if (!error) access = data; } catch (e) { console.warn(e); } window.bearAccess = access; return access; }
  function daysLeft(iso) { return Math.ceil((new Date(iso) - Date.now()) / 864e5); }
  function applyAccess() {
    document.body.classList.toggle("readonly", isRO());
    document.querySelectorAll(".menu-tile[data-goto]").forEach((t) => { const f = FEATURE_OF_VIEW[t.dataset.goto]; t.classList.toggle("plan-locked", !!(f && access && access.state !== "guest" && !hasFeature(f))); });
    let bar = document.getElementById("planBanner");
    const home = document.getElementById("view-home");
    const msg = !access || access.state === "guest" ? "" : isRO() ? `方案已在 ${fmtD(access.ends_at)} 到期，目前是<b>唯讀</b>：可以查看、匯出，不能新增或修改。` : access.state === "trial" && daysLeft(access.ends_at) <= 3 ? `免費體驗還剩 <b>${Math.max(0, daysLeft(access.ends_at))} 天</b>，到期後會變成唯讀。` : daysLeft(access.ends_at) <= 7 ? `方案還剩 <b>${Math.max(0, daysLeft(access.ends_at))} 天</b>到期，記得續約喔。` : "";
    if (home && msg) { if (!bar) { bar = document.createElement("div"); bar.id = "planBanner"; bar.className = "motor-warn plan-banner"; const hello = home.querySelector(".hello"); (hello || home.firstChild).after(bar); } bar.innerHTML = `${msg} <button type="button" class="link-btn">查看方案</button>`; bar.querySelector("button").onclick = () => openPlans(); bar.hidden = false; }
    else if (bar) bar.hidden = true;
    renderPlanCard();
  }
  const fmtD = (iso) => { const d = new Date(iso); return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`; };
  function renderPlanCard() {
    const anchor = document.getElementById("cloudAccount"); if (!anchor) return;
    let card = document.getElementById("planCard");
    if (!user || !access || access.state === "guest" || access.state === "none") { if (card) card.hidden = true; return; }
    if (!card) { card = document.createElement("div"); card.id = "planCard"; card.className = "plan-card"; anchor.after(card); }
    card.hidden = false;
    const total = Math.max(1, (new Date(access.ends_at) - new Date(access.starts_at)) / 864e5), left = daysLeft(access.ends_at), far = left > 3650;
    const pct = far ? 100 : Math.max(0, Math.min(100, (left / total) * 100));
    const aiCap = Math.max(1, (access.ai_total || 0) + (access.ai_bonus || 0)), aiPct = Math.max(0, Math.min(100, (access.ai_left / aiCap) * 100));
    const label = isRO() ? "已到期・唯讀" : access.state === "trial" ? "免費體驗中" : "使用中";
    card.innerHTML = `<div class="plan-top"><div><small>目前方案</small><b>${escH(access.plan)}</b></div><span class="plan-state ${isRO() ? "ro" : access.state}">${label}</span></div>
      <div class="plan-meter"><div class="plan-meter-head"><span>${far ? "長期有效" : isRO() ? `已在 ${fmtD(access.ends_at)} 到期` : `還有 <b>${left}</b> 天`}</span><small>${far ? "" : `到期日 ${fmtD(access.ends_at)}`}</small></div><div class="plan-track"><i style="width:0%" data-w="${pct}"></i><span class="plan-bear" style="left:0%" data-l="${pct}"></span></div></div>
      <div class="plan-meter"><div class="plan-meter-head"><span>AI 點數還有 <b>${access.ai_left}</b> 點</span><small>每月 ${access.ai_total} 點${access.ai_bonus ? `・加購剩 ${access.ai_bonus}` : ""}</small></div><div class="plan-track ai"><i style="width:0%" data-w="${aiPct}"></i></div></div>
      ${access.subject === "workspace" || ws ? `<p class="small-note" style="margin:6px 0 0">${ws ? `班級「${escH(ws.name)}」` : ""}${access.seats ? `・老師 ${access.members || 1}／${access.seats} 位` : ""}</p>` : ""}
      ${isRO() && access.delete_after ? `<p class="small-note" style="margin:8px 0 0;color:#b23b40;line-height:1.6">資料會保留到 ${fmtD(access.delete_after)}，之後依規定刪除。需要的話請先續約，或到下方「帳號與資料」下載。</p>` : ""}
      <div class="rt-actions" style="margin-top:10px"><button type="button" class="outline-btn" id="planOpen">${isRO() || access.state === "trial" ? "查看方案與付款" : "方案與加購點數"}</button></div>`;
    card.querySelector("#planOpen").onclick = () => openPlans();
    requestAnimationFrame(() => setTimeout(() => card.querySelectorAll("[data-w]").forEach((el) => el.style.width = el.dataset.w + "%"), 60));
    requestAnimationFrame(() => setTimeout(() => card.querySelectorAll("[data-l]").forEach((el) => el.style.left = `calc(${el.dataset.l}% - 12px)`), 60));
  }
  async function openPlans() {
    let view = document.getElementById("view-plans");
    if (!view) {
      view = document.createElement("section"); view.className = "view"; view.id = "view-plans";
      const anyView = document.querySelector("section.view"); anyView.parentNode.insertBefore(view, anyView);
    }
    if (!catalog) { try { const { data } = await sb.rpc("plan_catalog"); catalog = data; } catch {} }
    const c = catalog || { plans: [], topups: [] }, costs = c.ai_costs || {};
    const COST_NAMES = { routine: "讀作息表照片", roster: "讀全園班表", bus: "讀娃娃車名單", motor: "讀大肌肉活動規劃", calendar: "讀行事曆", lesson: "推薦學習指標", lessonChat: "AI 寫教案（每一輪）" };
    view.innerHTML = `<h2 class="page-title">方案與續約 <span class=illus-star aria-hidden=true></span></h2><p class="page-sub">${access ? `目前方案：<b>${escH(access.plan || "")}</b>${access.ends_at ? `・${isRO() ? "已到期" : "到期日 " + fmtD(access.ends_at)}` : ""}` : ""}</p>
      ${c.plans.map((p) => `<article class="lesson-card plan-offer ${access && access.plan_id === p.id ? "current" : ""}"><div class="plan-offer-top"><div><h4>${escH(p.name)}</h4><p>${escH(p.description || "")}</p></div>${access && access.plan_id === p.id ? '<span class="plan-state active">目前方案</span>' : ""}</div>
        <div class="plan-price"><b>NT$${p.price_month}</b><small>／月</small>${p.price_year ? `<span>年繳 NT$${p.price_year.toLocaleString()}（省 NT$${(p.price_month * 12 - p.price_year).toLocaleString()}）</span>` : ""}</div>
        <ul class="plan-feat"><li>老師人數：${p.seats} 位${p.extra_seat_price ? `（第 ${p.seats + 1} 位起 NT$${p.extra_seat_price}／人／月）` : ""}</li><li>每月 AI 點數：${p.ai_points} 點</li>${Object.entries(FEATURE_NAMES).filter(([k]) => k !== "ai").map(([k, n]) => `<li class="${p.features && p.features[k] ? "" : "no"}">${n}</li>`).join("")}</ul></article>`).join("")}
      ${(c.topups || []).length ? `<div class="section-head" style="margin-top:6px"><h3>AI 點數加購</h3></div><div class="plan-topups">${c.topups.map((t) => `<div class="plan-topup"><b>${escH(t.name || "")}</b><span>${t.points} 點</span><strong>NT$${t.price}</strong></div>`).join("")}</div><p class="small-note" style="margin:6px 2px 0">加購的點數不會過期，用完每月點數後才會扣。</p>` : ""}
      ${Object.keys(costs).length ? `<div class="lesson-card" style="margin-top:12px"><h4 style="margin:0 0 6px">每種 AI 工作扣幾點</h4>${Object.entries(costs).map(([k, v]) => `<div class="plan-cost"><span>${COST_NAMES[k] || k}</span><b>${v} 點</b></div>`).join("")}</div>` : ""}
      <div class="lesson-card pay-box" id="payBox" style="margin-top:12px"></div>
      <div class="lesson-card" id="payHistory" style="margin-top:12px" hidden></div>`;
    renderPayBox(); renderPayHistory();
    window.switchView && baseSwitch ? baseSwitch("plans") : window.switchView && switchView("plans");
  }

  // ---------- bank transfer: order → transfer → notice ----------
  const payOrder = { plan: "", cycle: "month", extra: 0, topup: -1 };
  function orderPrice() {
    const c = catalog || {}, pl = (c.plans || []).find((p) => p.id === payOrder.plan), t = (c.topups || [])[payOrder.topup];
    let amt = 0, months = 0;
    if (pl) { months = payOrder.cycle === "year" ? 12 : 1; amt = payOrder.cycle === "year" && pl.price_year ? pl.price_year : pl.price_month * months; amt += (payOrder.extra || 0) * (pl.extra_seat_price || 0) * months; }
    if (t) amt += t.price || 0;
    return { amt, pl, t };
  }
  function renderPayBox() {
    const box = document.getElementById("payBox"); if (!box) return;
    const c = catalog || {}, b = c.bank || {}, plans = c.plans || [], tops = c.topups || [];
    if (!payOrder.plan && payOrder.topup < 0 && access && plans.find((p) => p.id === access.plan_id)) payOrder.plan = access.plan_id;
    const { amt, pl } = orderPrice(), bankOk = b.bank_code && b.account;
    const copy = (v, label) => `<button type="button" class="pay-copy" data-copy="${escH(v)}" aria-label="複製${label}">複製</button>`;
    box.innerHTML = `<h4 style="margin:0 0 4px">選擇方案付款</h4><p class="small-note" style="margin:0 0 10px;line-height:1.6">選好方案後轉帳到下面的帳戶，轉帳完填寫轉出的銀行代碼和帳號末五碼，確認收款後就會自動開通。</p>
      <div class="field"><label>方案</label><select id="payPlan"><option value="">（不買方案，只加購點數）</option>${plans.map((p) => `<option value="${escH(p.id)}" ${p.id === payOrder.plan ? "selected" : ""}>${escH(p.name)}</option>`).join("")}</select></div>
      ${pl ? `<div class="cal-mode" style="margin-bottom:10px"><button type="button" data-cycle="month" class="${payOrder.cycle === "month" ? "active" : ""}"><b>月繳</b><small>NT$${pl.price_month}／月</small></button><button type="button" data-cycle="year" class="${payOrder.cycle === "year" ? "active" : ""}"><b>年繳</b><small>NT$${(pl.price_year || pl.price_month * 12).toLocaleString()}／年</small></button></div>${pl.extra_seat_price ? `<div class="field"><label>加購老師人數（方案已含 ${pl.seats} 位，每加 1 位 NT$${pl.extra_seat_price}／月）</label><input id="payExtra" type="number" min="0" max="20" inputmode="numeric" value="${payOrder.extra || 0}"></div>` : ""}` : ""}
      ${tops.length ? `<div class="field"><label>加購 AI 點數（選填）</label><select id="payTop"><option value="-1">不加購</option>${tops.map((t, i) => `<option value="${i}" ${i === payOrder.topup ? "selected" : ""}>${escH(t.name || "")} ${t.points} 點・NT$${t.price}</option>`).join("")}</select></div>` : ""}
      <div class="pay-total"><span>應付金額</span><b>NT$${amt.toLocaleString()}</b></div>
      ${bankOk ? `<div class="pay-bank"><div><small>銀行</small><b>${escH(b.bank_name || "")}（${escH(b.bank_code)}）</b>${copy(b.bank_code, "銀行代碼")}</div><div><small>帳號</small><b class="pay-acct">${escH(b.account)}</b>${copy(String(b.account).replace(/\D/g, ""), "帳號")}</div>${b.holder ? `<div><small>戶名</small><b>${escH(b.holder)}</b></div>` : ""}</div>` : `<p class="motor-warn" style="margin:0">付款帳戶還沒設定好，請稍後再試。</p>`}
      ${typeof c.pay_note === "string" && c.pay_note.trim() ? `<p class="small-note" style="line-height:1.7;white-space:pre-wrap;margin:8px 0 0">${escH(c.pay_note)}</p>` : ""}
      ${bankOk ? `<div class="pay-form"><b style="font-size:13px">轉帳後填寫</b><div class="two"><div class="field"><label>轉出銀行代碼（3 碼）</label><input id="payBank" inputmode="numeric" maxlength="3" placeholder="例如：822"></div><div class="field"><label>轉出帳號末五碼</label><input id="payLast5" inputmode="numeric" maxlength="5" placeholder="例如：12345"></div></div><div class="two"><div class="field"><label>轉帳日期</label><input id="payDate" type="date" value="${new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)}"></div><div class="field"><label>備註（選填）</label><input id="payNote" maxlength="100" placeholder="例如：幫班上另一位老師付"></div></div><button type="button" class="primary" id="paySend" ${amt ? "" : "disabled"}>送出付款通知</button></div>` : ""}`;
    box.querySelectorAll("[data-copy]").forEach((x) => x.onclick = async () => { try { await navigator.clipboard.writeText(x.dataset.copy); toast("已複製：" + x.dataset.copy); } catch { toast(x.dataset.copy); } });
    const sel = document.getElementById("payPlan"); sel.onchange = () => { payOrder.plan = sel.value; payOrder.extra = 0; renderPayBox(); };
    box.querySelectorAll("[data-cycle]").forEach((x) => x.onclick = () => { payOrder.cycle = x.dataset.cycle; renderPayBox(); });
    const ex = document.getElementById("payExtra"); if (ex) ex.onchange = () => { payOrder.extra = Math.max(0, Math.min(20, parseInt(ex.value, 10) || 0)); renderPayBox(); };
    const tp = document.getElementById("payTop"); if (tp) tp.onchange = () => { payOrder.topup = parseInt(tp.value, 10); renderPayBox(); };
    const send = document.getElementById("paySend");
    if (send) send.onclick = async () => {
      const bank = document.getElementById("payBank").value.trim(), last5 = document.getElementById("payLast5").value.trim();
      if (!/^\d{3}$/.test(bank)) return toast("請填 3 碼的轉出銀行代碼");
      if (!/^\d{5}$/.test(last5)) return toast("請填轉出帳號的末五碼");
      send.disabled = true;
      const { data, error } = await sb.rpc("submit_payment_notice", { p_plan: payOrder.plan || null, p_cycle: payOrder.cycle, p_extra: payOrder.extra || 0, p_topup: payOrder.topup >= 0 ? payOrder.topup : null, p_ws: ws ? ws.id : null, p_bank: bank, p_last5: last5, p_date: document.getElementById("payDate").value || null, p_note: document.getElementById("payNote").value.trim() });
      send.disabled = false;
      if (error) return toast(/too_many_pending/.test(error.message) ? "你已經有 3 筆付款通知在等待確認，確認後再送新的" : /empty_order/.test(error.message) ? "請選擇方案或加購項目" : "送出失敗：" + error.message);
      toast(`已送出付款通知（NT$${data.amount}），確認收款後會通知你 ♡`);
      payOrder.topup = -1; renderPayBox(); renderPayHistory();
    };
  }
  async function renderPayHistory() {
    const box = document.getElementById("payHistory"); if (!box || !sb) return;
    const { data } = await sb.rpc("my_payments"); const list = data || [];
    box.hidden = !list.length; if (!list.length) return;
    const ST = { pending: ["等待確認", "trial"], paid: ["已開通", "active"], failed: ["已退回", "ro"], refunded: ["已退款", "ro"] };
    box.innerHTML = `<h4 style="margin:0 0 8px">我的付款紀錄</h4>${list.map((p) => `<div class="pay-hist"><div><b>${escH([p.plan ? `${p.plan}（${p.cycle === "year" ? "年繳" : "月繳"}）` : "", p.extra_seats ? `加 ${p.extra_seats} 位老師` : "", p.topup_points ? `加購 ${p.topup_points} 點` : ""].filter(Boolean).join("、"))}</b><small>${fmtD(p.created_at)}・NT$${p.amount.toLocaleString()}・末五碼 ${escH(p.from_last5 || "")}${p.status === "failed" && p.note ? `<br>退回原因：${escH(p.note)}` : ""}</small></div><span class="plan-state ${ST[p.status]?.[1] || ""}">${ST[p.status]?.[0] || p.status}</span></div>`).join("")}`;
  }

  // ---------- announcements ----------
  async function showAnnouncements() {
    if (!sb || !user) return;
    let list = []; try { const { data } = await sb.rpc("current_announcements"); list = data || []; } catch { return; }
    let seen = []; try { seen = JSON.parse(rawGet.call(LS, "bear_ann_seen") || "[]"); } catch {}
    const show = list.filter((a) => !seen.includes(a.id));
    const home = document.getElementById("view-home"); if (!home) return;
    let box = document.getElementById("annBox");
    if (!show.length) { if (box) box.remove(); return; }
    if (!box) { box = document.createElement("div"); box.id = "annBox"; const hello = home.querySelector(".hello"); (hello || home.firstChild).after(box); }
    box.innerHTML = show.map((a) => `<div class="ann ${a.level === "important" ? "imp" : ""}"><div><b>${a.level === "important" ? "📢 " : "✨ "}${escH(a.title)}</b>${a.body ? `<p>${escH(a.body)}</p>` : ""}<small>${fmtD(a.starts_at)}・小熊工作室</small></div><button type="button" data-ann="${a.id}" aria-label="知道了">知道了</button></div>`).join("");
    box.querySelectorAll("[data-ann]").forEach((b) => b.onclick = () => { seen.push(+b.dataset.ann); try { rawSet.call(LS, "bear_ann_seen", JSON.stringify(seen.slice(-50))); } catch {} b.closest(".ann").remove(); if (!box.children.length) box.remove(); });
  }
  // ---------- feedback ----------
  const FB_CAT = { question: "使用問題", bug: "回報錯誤", idea: "許願／建議", billing: "付款與方案", other: "其他" };
  async function renderFeedback() {
    let card = document.getElementById("fbCard");
    const after = document.getElementById("appCardLogin") || document.getElementById("cloudAccount");
    if (!user || !after) { if (card) card.hidden = true; return; }
    if (!card) { card = document.createElement("div"); card.id = "fbCard"; card.className = "lesson-card"; after.after(card); }
    card.hidden = false;
    let mine = []; try { const { data } = await sb.rpc("my_feedback"); mine = data || []; } catch {}
    card.innerHTML = `<div class="lesson-top"><div class="lesson-icon"><span class=illus-note aria-hidden=true></span></div><div><h4>意見回饋</h4><p>使用上有問題、發現錯誤，或想要新功能，都可以跟我們說，回覆會傳到你的 LINE。</p></div></div>
      <div class="field" style="margin-top:12px"><label>類型</label><select id="fbCat">${Object.entries(FB_CAT).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></div>
      <div class="field"><label>想說的話</label><textarea id="fbMsg" rows="3" maxlength="2000" placeholder="例如：上傳班表時讀錯了某一格、希望可以多一個○○功能…（請不要寫學生的個資）"></textarea></div>
      <button type="button" class="primary" id="fbSend">送出</button>
      ${mine.length ? `<div class="small-note" style="margin:14px 2px 6px;font-weight:700">我送出的意見</div>${mine.map((f) => `<div class="fb-item"><div class="fb-top"><span class="tag">${escH(FB_CAT[f.category] || f.category)}</span><small>${fmtD(f.created_at)}</small><span class="plan-state ${f.status === "open" ? "trial" : "active"}">${f.status === "open" ? "處理中" : f.status === "replied" ? "已回覆" : "已結案"}</span></div><p>${escH(f.message)}</p>${f.reply ? `<div class="fb-reply"><b>小熊工作室回覆：</b>${escH(f.reply)}</div>` : ""}</div>`).join("")}` : ""}`;
    card.querySelector("#fbSend").onclick = async () => {
      const msg = card.querySelector("#fbMsg").value.trim(); if (msg.length < 2) return toast("請寫下想說的話");
      const { error } = await sb.rpc("submit_feedback", { p_category: card.querySelector("#fbCat").value, p_message: msg });
      if (error) return toast(/too_many/.test(error.message) ? "今天已經送出很多則了，明天再試" : "送出失敗：" + error.message);
      toast("已送出，謝謝你 ♡ 回覆會傳到你的 LINE"); renderFeedback();
    };
  }
  // ---------- my account: export / delete ----------
  function renderAccountCard() {
    let card = document.getElementById("acctCard");
    const after = document.getElementById("fbCard") || document.getElementById("cloudAccount");
    if (!user || !after) { if (card) card.hidden = true; return; }
    if (!card) { card = document.createElement("div"); card.id = "acctCard"; card.className = "lesson-card"; after.after(card); }
    card.hidden = false;
    card.innerHTML = `<div class="lesson-top"><div class="lesson-icon"><span class=illus-safety aria-hidden=true></span></div><div><h4>帳號與資料</h4><p>你的資料只存在雲端。可以隨時下載一份自己的資料，或刪除帳號。</p></div></div>
      <div class="rt-actions" style="margin-top:12px"><button type="button" class="outline-btn" id="acctExport">下載我的資料</button><button type="button" class="outline-btn" id="acctDel" style="color:#b0534f">刪除帳號</button></div>
      <div id="acctDelBox" class="motor-warn" hidden></div>`;
    card.querySelector("#acctExport").onclick = () => { exportBackup(); toast("已下載。檔案裡有學生資料，請妥善保管"); };
    card.querySelector("#acctDel").onclick = () => {
      const box = card.querySelector("#acctDelBox"); box.hidden = false;
      box.innerHTML = `<b>確定要刪除帳號嗎？</b><p style="margin:6px 0;line-height:1.7">會刪除你的個人資料（待辦、行事曆、研習紀錄…）和登入帳號，<b>無法復原</b>。你建立的班級：如果還有其他老師，會交給另一位老師管理；只有你一個人的班級會連同班級資料一起刪除。<br>建議先按「下載我的資料」留一份。</p><div class="field"><label>請輸入「刪除」兩個字確認</label><input id="acctConfirm" placeholder="刪除"></div><div class="rt-actions"><button type="button" class="outline-btn" id="acctNo">取消</button><button type="button" class="outline-btn" id="acctYes" style="color:#b0534f">永久刪除</button></div>`;
      box.querySelector("#acctNo").onclick = () => { box.hidden = true; };
      box.querySelector("#acctYes").onclick = async () => {
        if (box.querySelector("#acctConfirm").value.trim() !== "刪除") return toast("請輸入「刪除」確認");
        const { data } = await sb.auth.getSession();
        const r = await fetch(CFG.supabaseUrl + "/functions/v1/account", { method: "POST", headers: { "Content-Type": "application/json", apikey: CFG.supabaseKey, Authorization: "Bearer " + data.session.access_token }, body: JSON.stringify({ confirm: "刪除" }) });
        const b = await r.json().catch(() => ({}));
        if (!r.ok) return toast("刪除失敗：" + (b.error || r.status));
        toast("帳號已刪除，謝謝你使用小熊工作室");
        MEM.clear(); wipeLegacy(); try { await sb.auth.signOut(); } catch {}
        const drop = []; for (let i = 0; i < LS.length; i++) { const k = LS.key(i); if (k && k.startsWith("bear_")) drop.push(k); } drop.forEach((k) => { try { rawRemove.call(LS, k); } catch {} });
        setTimeout(() => location.replace(location.pathname), 1500);
      };
    };
  }
  // ---------- class change history ----------
  const KEY_NAMES = { bear_student_records: "學生名冊／寶貝補給品", bear_forms: "回條小幫手", bear_fund_records: "班級資金", bear_fund_types: "班級資金分類", bear_afterschool: "課後才藝", bear_bus_routes: "娃娃車車次", bear_bus_riders: "娃娃車名單", bear_teacher_map: "老師名單", bear_roster_rows: "全園班表", bear_sub_records: "代班紀錄", bear_routine: "班級作息表", bear_motor_days: "大肌肉活動", bear_motor_plans: "大肌肉活動規劃", bear_lessons: "教案花園", bear_lesson_themes: "教案主題", bear_attendance: "出缺勤", bear_logs: "週誌月報" };
  async function openHistory(box) {
    if (!ws) return;
    box.hidden = false; box.innerHTML = '<p class="small-note">載入中…</p>';
    const { data, error } = await sb.rpc("class_history", { p_ws: ws.id });
    if (error) { box.innerHTML = `<p class="small-note">讀取失敗：${escH(error.message)}</p>`; return; }
    const list = data || [];
    box.innerHTML = `<div class="section-head"><h3 style="font-size:14px">修改紀錄（最近 30 天）</h3><button type="button" class="link-btn" data-hclose="1">收起</button></div><p class="small-note" style="margin:0 0 8px;line-height:1.6">每次有人修改班級資料，都會保留修改前的版本。誤刪或改錯時，可以還原到修改前；還原後也能再還原回來。</p>${list.length ? list.map((h) => `<div class="hist-row"><div><b>${escH(KEY_NAMES[h.key] || h.key)}</b><small>${new Date(h.at).toLocaleString("zh-TW", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}・${escH(h.by || "老師")} 修改${h.size != null ? `・修改前有 ${h.size} 筆` : ""}</small></div><button type="button" class="outline-btn" data-restore="${h.id}">還原成修改前</button></div>`).join("") : '<p class="small-note">還沒有修改紀錄。</p>'}`;
    box.querySelector("[data-hclose]").onclick = () => { box.hidden = true; };
    box.querySelectorAll("[data-restore]").forEach((b) => b.onclick = async () => {
      if (!confirm("確定要把這項資料還原成這次修改之前的樣子嗎？同班老師也會一起看到還原後的內容。")) return;
      const { error: e2 } = await sb.rpc("restore_history", { p_id: +b.dataset.restore });
      if (e2) return toast(/plan_readonly/.test(e2.message) ? "方案已到期，不能還原" : "還原失敗：" + e2.message);
      toast("已還原，重新整理後就會看到"); setTimeout(() => reloadApp(), 800);
    });
  }

  async function preload() {
    const list = await loadWorkspaces();
    lastList = list;
    const saved = meta().ws, pickWs = list.find((w) => w.status !== "pending" && saved && w.id === saved.id) || (list.filter((w) => w.status !== "pending").length === 1 ? list.find((w) => w.status !== "pending") : null);
    ws = pickWs; const m = meta(); m.ws = ws ? { id: ws.id, name: ws.name } : null; saveMeta(m);
    await Promise.all([loadAccess(), pull({ reloadIfChanged: false }), sb.rpc("plan_catalog").then(({ data }) => { catalog = data; }, () => {})]);
    await flushDirty();
  }
  async function boot() {
    let loadFailed = false;
    if (window.supabase) {
      sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, { auth: { persistSession: true, autoRefreshToken: true, storageKey: "bear_cloud_auth" } });
      try { const { data } = await sb.auth.getSession(); user = data.session?.user || null; } catch (e) { console.error(e); }
    }
    guest = !user;
    if (user) { try { await preload(); } catch (e) { console.error(e); loadFailed = true; } }
    else wipeLegacy();
    startApp();
    const css = document.createElement("style");
    css.textContent = `.cloud-me{display:flex;align-items:center;gap:10px}.cloud-me img{border-radius:50%;object-fit:cover}.cloud-me b{display:block;font-size:14px;color:#5d4b44}.cloud-me small{font-size:11px;color:#9a8980}.cloud-code{background:#f6e9e5;border-radius:13px;padding:13px;margin:10px 0}.cloud-code small{display:block;font-size:11px;color:#9a8980}.cloud-code b{display:block;font-size:25px;letter-spacing:4px;font-weight:800;color:#a66f72;margin:6px 0}.cloud-bar{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(92px + env(safe-area-inset-bottom,0px));z-index:45;display:flex;gap:10px;align-items:center;background:#61524b;color:#fff;border-radius:16px;padding:10px 12px 10px 16px;font-size:12px;box-shadow:0 8px 25px #49372d33;max-width:calc(100% - 32px)}.app-steps{margin:8px 0 4px;padding-left:20px;font-size:12px;line-height:1.9;color:#6e5d54}.app-ok{color:#728369!important;margin:10px 0 6px!important;line-height:1.7}#appCard .rt-actions,#appCardLogin .rt-actions{margin-top:8px}.cloud-pend{display:flex;align-items:center;gap:8px;margin-top:8px}.cloud-pend span{flex:1;font-weight:700}.cloud-pend .outline-btn{padding:6px 12px}.cloud-x{background:transparent;color:inherit;padding:0 0 0 4px;font-size:13px}.plan-card{background:linear-gradient(135deg,#fbefec,#fff8ef);border:1px solid #f0dcd6;border-radius:18px;padding:14px;margin-top:12px}.plan-top{display:flex;justify-content:space-between;align-items:flex-start;gap:8px}.plan-top small{display:block;font-size:11px;color:#9a8980}.plan-top b{font-size:17px;color:#5d4b44}.plan-state{font-size:11px;font-weight:700;border-radius:999px;padding:4px 10px;white-space:nowrap;background:#e7efe1;color:#5f7552}.plan-state.trial{background:#fbe9cc;color:#a2660f}.plan-state.ro{background:#fde2e1;color:#b23b40}.plan-meter{margin-top:12px}.plan-meter-head{display:flex;justify-content:space-between;align-items:baseline;gap:8px;font-size:12.5px;color:#6e5d54}.plan-meter-head b{font-size:16px;color:#a66f72}.plan-meter-head small{font-size:10.5px;color:#9a8980}.plan-track{position:relative;height:12px;border-radius:999px;background:#f1e4dc;margin-top:7px;overflow:visible}.plan-track i{position:absolute;left:0;top:0;bottom:0;border-radius:999px;background:linear-gradient(90deg,#e8c4b7,#d6a5a2);transition:width 1.4s cubic-bezier(.2,.8,.2,1)}.plan-track.ai i{background:linear-gradient(90deg,#c9bde3,#9e8fc9)}.plan-bear{position:absolute;top:-9px;width:26px;height:26px;border-radius:50%;background:#fffdf9 url(/icon-192.png) center/cover;box-shadow:0 2px 6px #82645133;transition:left 1.4s cubic-bezier(.2,.8,.2,1);animation:planbob 2.4s ease-in-out infinite}@keyframes planbob{50%{transform:translateY(-3px)}}body.readonly #fab{display:none!important}.plan-banner{margin:12px 0 0}.menu-tile.plan-locked{opacity:.55;position:relative}.menu-tile.plan-locked::after{content:"方案未包含";position:absolute;top:8px;right:10px;font-size:9px;color:#8d786d;background:#f1e4dc;border-radius:999px;padding:2px 7px}.plan-offer.current{border:2px solid #d6a5a2}.plan-offer-top{display:flex;justify-content:space-between;gap:8px}.plan-offer h4{margin:0;font-size:16px;color:#5d4b44}.plan-offer p{margin:4px 0 0;font-size:12px;color:#8d786d}.plan-price{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 8px;margin:10px 0}.plan-price b{font-size:26px;color:#a66f72}.plan-price small{color:#9a8980}.plan-price span{font-size:11.5px;color:#728369;background:#edf2e9;border-radius:999px;padding:3px 9px}.plan-feat{list-style:none;padding:0;margin:0;display:grid;grid-template-columns:1fr 1fr;gap:4px 10px;font-size:12px;color:#6e5d54}.plan-feat li::before{content:"✓ ";color:#728369;font-weight:700}.plan-feat li.no{color:#b8a9a0;text-decoration:line-through}.plan-feat li.no::before{content:"✕ ";color:#c9b6a9}.plan-feat li:nth-child(-n+2){grid-column:1/-1;font-weight:700}.plan-topups{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.plan-topup{background:var(--paper);border:1px solid #f0e5dc;border-radius:14px;padding:10px 6px;text-align:center;display:grid;gap:2px}.plan-topup b{font-size:11.5px;color:#8d786d}.plan-topup span{font-size:15px;font-weight:800;color:#5d4b44}.plan-topup strong{font-size:13px;color:#a66f72}.plan-cost{display:flex;justify-content:space-between;font-size:12.5px;padding:5px 0;border-bottom:1px dashed #f0e5dc;color:#6e5d54}.pay-total{display:flex;justify-content:space-between;align-items:baseline;background:#fbf3ee;border-radius:12px;padding:10px 12px;margin:4px 0 10px}.pay-total b{font-size:22px;color:#a66f72}.pay-bank{display:grid;gap:8px;background:#fffaf5;border:1px dashed #e3c4c0;border-radius:14px;padding:12px}.pay-bank>div{display:grid;grid-template-columns:44px minmax(0,1fr) auto;gap:8px;align-items:center}.pay-bank small{font-size:11px;color:#9a8980}.pay-bank b{font-size:14.5px;color:#5d4b44;overflow-wrap:anywhere}.pay-acct{font-size:17px!important;letter-spacing:1px;font-variant-numeric:tabular-nums}.pay-copy{background:#f6e9e5;color:#8d625e;border-radius:8px;padding:5px 10px;font-size:11.5px}.pay-form{margin-top:12px;border-top:1px solid #f0e5dc;padding-top:12px;display:grid;gap:6px}.pay-form .primary:disabled{opacity:.5}.pay-hist{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px 0;border-bottom:1px dashed #f0e5dc}.pay-hist b{display:block;font-size:13px;color:#5d4b44}.pay-hist small{font-size:11px;color:#9a8980;line-height:1.6}.ann{display:flex;gap:10px;align-items:flex-start;background:#eef3f9;border:1px solid #dfe7f1;border-radius:16px;padding:12px 14px;margin:12px 0 0}.ann.imp{background:#fff1f0;border-color:#f6cfcc}.ann>div{flex:1;min-width:0}.ann b{font-size:14px;color:#4f6f97}.ann.imp b{color:#b23b40}.ann p{margin:4px 0;font-size:12.5px;line-height:1.7;color:#5d4b44;white-space:pre-wrap}.ann small{font-size:10.5px;color:#9a8980}.ann button{background:#fffdf9;color:#6e5d54;border-radius:10px;padding:6px 10px;font-size:12px;white-space:nowrap}.fb-item{border-top:1px dashed #f0e5dc;padding:9px 0}.fb-top{display:flex;gap:8px;align-items:center}.fb-top small{color:#9a8980;font-size:11px;flex:1}.fb-item p{margin:6px 0 0;font-size:13px;line-height:1.6;white-space:pre-wrap}.fb-reply{margin-top:6px;background:#f3f6fb;border-radius:10px;padding:8px 10px;font-size:12.5px;line-height:1.6;white-space:pre-wrap}.hist-box{margin-top:10px}.hist-row{display:flex;gap:10px;align-items:center;justify-content:space-between;padding:8px 0;border-top:1px dashed #f0e5dc}.hist-row b{display:block;font-size:13px}.hist-row small{font-size:11px;color:#9a8980}.hist-row .outline-btn{white-space:nowrap;padding:6px 10px;font-size:12px}.cloud-bar button{background:#fff;color:#61524b;border-radius:10px;padding:7px 10px;font-size:12px;font-weight:700;white-space:nowrap}`;
    document.head.appendChild(css);
    installGuestUI();
    window.startLineLogin = startLogin;
    window.createTeam = createClass;
    window.joinTeam = joinClass;
    window.bearCloud = { finishLogin, pull, push, exportBackup, importBackup, merge, get user() { return user; }, get ws() { return ws; } };
    const fr = document.getElementById("oaFriend");
    if (fr && CFG.oaBasicId) { fr.href = "https://line.me/R/ti/p/" + encodeURIComponent(CFG.oaBasicId); fr.hidden = false; }
    const nt = document.getElementById("notifyTest");
    if (nt) nt.onclick = async () => {
      const out = document.getElementById("notifyTestMsg");
      if (!user) { toast("請先用 LINE 登入"); return; }
      out.textContent = "傳送中…";
      try {
        const { data } = await sb.auth.getSession();
        const r = await fetch(CFG.supabaseUrl + "/functions/v1/line-notify", { method: "POST", headers: { "Content-Type": "application/json", apikey: CFG.supabaseKey, Authorization: "Bearer " + data.session.access_token }, body: JSON.stringify({ mode: "test" }) });
        const b = await r.json();
        out.textContent = r.ok ? "已傳出，打開 LINE 看看「熊班」的訊息 ♡" : "沒有傳出去：" + (b.error || "請稍後再試");
      } catch (e) { out.textContent = "沒有傳出去：" + (e.message || e); }
    };
    const bf = document.getElementById("backupFile");
    if (bf) bf.addEventListener("change", (e) => { const f = e.target.files?.[0]; if (f) importBackup(f); e.target.value = ""; });
    const be = document.getElementById("backupExport");
    if (be) be.onclick = exportBackup;
    if (!sb) { setGuest(true); renderCloudUI(); return; }
    // Back from LINE for a login started in the home-screen app: hand it to the app even if this browser is already signed in.
    if (BOOT_PAIR && !myPairs().includes(BOOT_PAIR) && CFG.liffId && /[?&](code|liffClientId|liff\.state|pair)=/.test(location.search)) {
      setGuest(!user); renderCloudUI();
      try { report("正在把登入交給主畫面的 App…"); await initLiff(); if (liff.isLoggedIn()) { await exchange(liff.getIDToken()); return; } }
      catch (e) { console.error(e); report("登入失敗：" + (e.message || e)); }
    }
    setGuest(!user);
    if (user) {
      subscribe(); renderCloudUI(lastList); renderAppCards(); renderPairCodeBox(); applyAccess(); showAnnouncements(); renderFeedback().then(renderAccountCard);
      if (loadFailed) setStatus("連不到雲端，現在看到的不是最新資料，修改也還沒存到雲端；連上網路後會自動重試"); else wipeLegacy();
    }
    else {
      renderCloudUI();
      // coming back from the LINE login page
      if (CFG.liffId && (/[?&](code|liffClientId|liff\.state)=/.test(location.search) || /\bLine\//i.test(navigator.userAgent))) {
        try { report("步驟 2／3：從 LINE 回來了，正在確認…"); await initLiff(); if (liff.isLoggedIn()) await exchange(liff.getIDToken()); else report("LINE 還沒有完成登入，請再按一次「使用 LINE 帳號登入」"); history.replaceState(null, "", location.pathname); }
        catch (e) { console.error(e); report("登入失敗：" + (e.message || e)); toast("登入失敗：" + (e.message || e)); }
      }
    }
    registerSW().then(renderAppCards);
    checkUpdate("boot");
    const v0 = new URLSearchParams(location.search).get("view");
    if (v0 && window.switchView) { switchView(v0); history.replaceState(null, "", location.pathname); }
    else if (/[?&]v=\d+/.test(location.search) && !/[?&](code|liffClientId|liff\.state|pair)=/.test(location.search)) history.replaceState(null, "", location.pathname);
    if (!user && myPairs().length) watchPairs();
    renderPairCodeBox();
    window.addEventListener("online", flushDirty);
    document.addEventListener("visibilitychange", () => { if (!document.hidden && !user) claimPairedLogin(); if (!document.hidden && user) flushDirty().then(() => pull({ reloadIfChanged: false }).then((c) => c && needsRefresh("雲端有新的資料"))); });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
