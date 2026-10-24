// 小熊工作室 cloud sync: LINE sign-in (LIFF) + Supabase.
// The app keeps working from localStorage exactly as before. This file signs the teacher in,
// mirrors the bear_* keys to the cloud, and pulls classmates' changes back.
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
  const SHARED = ["bear_student_records", "bear_forms", "bear_fund_records", "bear_teacher_map", "bear_roster_rows", "bear_sub_records", "bear_routine", "bear_motor_days", "bear_motor_plans", "bear_lessons", "bear_lesson_themes"];
  const PERSONAL = ["bear_tasks", "bear_trainings", "bear_schedules", "bear_profile", "bear_chores", "bear_notify_prefs", "bear_file_note", "bear_cal_events", "bear_cal_plans"];
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
  const meta = () => { try { return JSON.parse(rawGet.call(LS, "bear_cloud_meta") || "{}"); } catch { return {}; } };
  const saveMeta = (m) => rawSet.call(LS, "bear_cloud_meta", JSON.stringify(m));
  const toast = (m) => (window.showToast ? window.showToast(m) : console.log(m));
  const escH = (s) => (window.esc ? window.esc(s) : String(s ?? ""));

  let sb = null, user = null, ws = null, channel = null, muted = false;
  const timers = {}, inflight = {};

  // ---------- storage hook ----------
  const KEEP_ALWAYS = ["bear_cloud_meta", "bear_cloud_auth", "bear_login_msg"];
  let guest = !rawGet.call(LS, "bear_cloud_auth");
  Storage.prototype.setItem = function (k, v) {
    if (this === LS && guest && String(k).startsWith("bear_") && !KEEP_ALWAYS.includes(k) && !String(k).startsWith("bear_cloud")) return; // signed out: keep only in memory
    rawSet.call(this, k, v);
    if (this === LS && !muted && user && (SHARED.includes(k) || PERSONAL.includes(k))) queuePush(k);
  };
  function writeLocal(k, value) { muted = true; try { rawSet.call(LS, k, typeof value === "string" ? value : JSON.stringify(value)); } finally { muted = false; } }
  function readLocal(k) { const v = rawGet.call(LS, k); if (v == null) return undefined; try { return JSON.parse(v); } catch { return v; } }

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
      if (PERSONAL.includes(k)) {
        const { error } = await sb.from("personal_data").upsert({ user_id: user.id, key: k, value, updated_at: new Date().toISOString() });
        if (error) throw error;
      } else {
        if (!ws) return; // not in a class yet: stays on this device
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
    for (const k of PERSONAL) {
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
  function reloadApp() {
    try { sessionStorage.setItem("bear_cloud_reloaded", String(Date.now())); } catch {}
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
    const { data, error } = await sb.from("workspace_members").select("role, workspaces(id,name,invite_code)").eq("user_id", user.id);
    if (error) throw error;
    return (data || []).map((r) => ({ ...r.workspaces, role: r.role }));
  }
  async function chooseWorkspace(w, { upload = false } = {}) {
    ws = w || null;
    const m = meta(); m.ws = ws ? { id: ws.id, name: ws.name } : null; if (upload && ws) m.uploadLocalTo = ws.id; saveMeta(m);
    subscribe();
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
    const drop = []; for (let i = 0; i < LS.length; i++) { const k = LS.key(i); if (k.startsWith("bear_") && !k.startsWith("bear_cloud")) drop.push(k); }
    drop.forEach((k) => LS.removeItem(k)); LS.removeItem("bear_cloud_meta");
    toast("已登出，你的資料都安全存在雲端");
    setTimeout(() => location.reload(), 900);
  }
  async function afterSignIn(fresh) {
    const list = await loadWorkspaces();
    const saved = meta().ws, pickWs = list.find((w) => saved && w.id === saved.id) || (list.length === 1 ? list[0] : null);
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
    if (ws) { const { data } = await sb.from("workspace_members").select("role, user_id").eq("workspace_id", ws.id); const ids = (data || []).map((m) => m.user_id); const { data: ps } = ids.length ? await sb.from("profiles").select("id, display_name").in("id", ids) : { data: [] }; const nm = new Map((ps || []).map((p) => [p.id, p.display_name])); members = (data || []).map((m) => ({ ...m, profiles: { display_name: nm.get(m.user_id) } })); }
    team.innerHTML = `${ls.length ? `<div class="field"><label>目前使用的班級</label><select id="cloudWsSel">${ls.map((w) => `<option value="${w.id}" ${ws && w.id === ws.id ? "selected" : ""}>${escH(w.name)}${w.role === "owner" ? "（建立者）" : ""}</option>`).join("")}<option value="">（不使用班級，資料只存在這台裝置）</option></select></div>` : ""}
      ${ws ? `<div class="cloud-code"><small>邀請碼（給同班老師輸入）</small><b>${escH(ls.find((w) => w.id === ws.id)?.invite_code || "")}</b><div class="rt-actions"><button type="button" class="outline-btn" id="cloudCopy">複製邀請碼</button>${ls.find((w) => w.id === ws.id)?.role === "owner" ? `<button type="button" class="outline-btn" id="cloudRenew">換一組新的邀請碼</button>` : ""}<button type="button" class="outline-btn" id="cloudLeave">退出這個班級</button></div></div><div class="small-note" style="margin:10px 0 4px">班級成員（${members.length}）</div><div class="fm-chips">${members.map((m) => `<span class="tag ${m.role === "owner" ? "" : "green"}">${escH(m.profiles?.display_name || "老師")}${m.role === "owner" ? " · 建立者" : ""}</span>`).join("")}</div>` : ""}
      <div id="cloudLeaveConfirm" class="motor-warn" hidden></div>`;
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
    if (error) return toast("建立失敗：" + error.message);
    lastList = await loadWorkspaces();
    await chooseWorkspace(lastList.find((w) => w.id === data.id), { upload: true });
    toast(`已建立「${escH(name)}」，邀請碼：${data.invite_code}`);
  }
  async function joinClass() {
    if (!user) { toast("請先用 LINE 登入"); window.switchView && switchView("login"); return; }
    const code = (document.getElementById("joinCode")?.value || "").trim();
    if (!code) { toast("請輸入邀請碼"); return; }
    const { data, error } = await sb.rpc("join_workspace", { p_code: code });
    if (error) return toast(/not found/.test(error.message) ? "找不到這個邀請碼，請再確認一次" : "加入失敗：" + error.message);
    lastList = await loadWorkspaces();
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
    const res = await fetch(CFG.supabaseUrl + "/functions/v1/ai-read", { method: "POST", headers: { "Content-Type": "application/json", apikey: CFG.supabaseKey, Authorization: "Bearer " + data.session.access_token }, body: JSON.stringify({ kind, images, context }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.ok) throw new Error(body.error || "AI 讀圖失敗");
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
    for (let i = 0; i < LS.length; i++) { const k = LS.key(i); if (k.startsWith("bear_") && k !== "bear_cloud_meta") out[k] = rawGet.call(LS, k); }
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
  async function boot() {
    const css = document.createElement("style");
    css.textContent = `.cloud-me{display:flex;align-items:center;gap:10px}.cloud-me img{border-radius:50%;object-fit:cover}.cloud-me b{display:block;font-size:14px;color:#5d4b44}.cloud-me small{font-size:11px;color:#9a8980}.cloud-code{background:#f6e9e5;border-radius:13px;padding:13px;margin:10px 0}.cloud-code small{display:block;font-size:11px;color:#9a8980}.cloud-code b{display:block;font-size:25px;letter-spacing:4px;font-weight:800;color:#a66f72;margin:6px 0}.cloud-bar{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(92px + env(safe-area-inset-bottom,0px));z-index:45;display:flex;gap:10px;align-items:center;background:#61524b;color:#fff;border-radius:16px;padding:10px 12px 10px 16px;font-size:12px;box-shadow:0 8px 25px #49372d33;max-width:calc(100% - 32px)}.app-steps{margin:8px 0 4px;padding-left:20px;font-size:12px;line-height:1.9;color:#6e5d54}.app-ok{color:#728369!important;margin:10px 0 6px!important;line-height:1.7}#appCard .rt-actions,#appCardLogin .rt-actions{margin-top:8px}.cloud-bar button{background:#fff;color:#61524b;border-radius:10px;padding:7px 10px;font-size:12px;font-weight:700;white-space:nowrap}`;
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
    if (!window.supabase) { setGuest(true); renderCloudUI(); return; }
    sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, { auth: { persistSession: true, autoRefreshToken: true, storageKey: "bear_cloud_auth" } });
    const { data } = await sb.auth.getSession();
    user = data.session?.user || null;
    setGuest(!user);
    if (user) { try { await afterSignIn(false); } catch (e) { console.error(e); setStatus("暫時無法同步，連上網路後會自動重試"); } }
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
