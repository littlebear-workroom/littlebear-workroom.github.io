// 小熊工作室 cloud sync: LINE sign-in (LIFF) + Supabase.
// The app keeps working from localStorage exactly as before. This file signs the teacher in,
// mirrors the bear_* keys to the cloud, and pulls classmates' changes back.
(function () {
  "use strict";
  const CFG = {
    supabaseUrl: "https://cwsxlfifpydxmmjsiwzg.supabase.co",
    supabaseKey: "sb_publishable_2e3Qb6cB7J70m4d7JSCKlg_HVQNsOS7",
    liffId: "2012187193-uL27Ayag",
  };
  // Data the whole class shares vs. data that belongs to one teacher.
  const SHARED = ["bear_student_records", "bear_forms", "bear_fund_records", "bear_teacher_map", "bear_roster_rows", "bear_sub_records", "bear_routine", "bear_motor_days", "bear_motor_plans", "bear_lessons", "bear_lesson_themes"];
  const PERSONAL = ["bear_tasks", "bear_trainings", "bear_schedules", "bear_profile", "bear_chores", "bear_notify_prefs", "bear_file_note", "bear_cal_events", "bear_cal_plans"];
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
  Storage.prototype.setItem = function (k, v) {
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
    const res = await fetch(CFG.supabaseUrl + "/functions/v1/line-auth", { method: "POST", headers: { "Content-Type": "application/json", apikey: CFG.supabaseKey }, body: JSON.stringify({ idToken }) });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "登入失敗");
    return finishLogin(body);
  }
  async function finishLogin({ token_hash }) {
    const { data, error } = await sb.auth.verifyOtp({ token_hash, type: "magiclink" });
    if (error) throw error;
    user = data.user;
    await afterSignIn(true);
  }
  async function startLogin() {
    try {
      if (!CFG.liffId) { toast("LINE 登入還在設定中，設定好之後就能用了"); return; }
      setStatus("正在連到 LINE…");
      await initLiff();
      if (!liff.isLoggedIn()) { liff.login({ redirectUri: location.origin + location.pathname }); return; }
      await exchange(liff.getIDToken());
    } catch (e) { console.error(e); toast("登入失敗：" + (e.message || e)); setStatus(""); }
  }
  async function signOut() {
    await sb.auth.signOut(); user = null; ws = null; if (channel) sb.removeChannel(channel);
    try { if (window.liff && liff.isLoggedIn && liff.isLoggedIn()) liff.logout(); } catch {}
    const m = meta(); m.ws = null; saveMeta(m);
    renderCloudUI(); toast("已登出，資料仍保留在這台裝置");
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

  // ---------- UI on the 登入 and 班級共享 pages ----------
  let lastList = null;
  function setStatus(t) { const el = document.getElementById("cloudStatus"); if (el) el.textContent = t; }
  async function renderCloudUI(list) {
    if (list) lastList = list;
    const box = document.getElementById("cloudAccount"), team = document.getElementById("cloudTeam");
    if (!box || !team) return;
    const lb = document.querySelector(".line-login"); if (lb) lb.style.display = user ? "none" : "flex";
    if (!user) {
      box.innerHTML = `<p class="small-note" style="line-height:1.7;margin:0">登入後，資料會存到雲端，換手機或電腦也看得到；同班老師加入同一個班級後會自動同步。</p>`;
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
    css.textContent = `.cloud-me{display:flex;align-items:center;gap:10px}.cloud-me img{border-radius:50%;object-fit:cover}.cloud-me b{display:block;font-size:14px;color:#5d4b44}.cloud-me small{font-size:11px;color:#9a8980}.cloud-code{background:#f6e9e5;border-radius:13px;padding:13px;margin:10px 0}.cloud-code small{display:block;font-size:11px;color:#9a8980}.cloud-code b{display:block;font-size:25px;letter-spacing:4px;font-weight:800;color:#a66f72;margin:6px 0}.cloud-bar{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(92px + env(safe-area-inset-bottom,0px));z-index:45;display:flex;gap:10px;align-items:center;background:#61524b;color:#fff;border-radius:16px;padding:10px 12px 10px 16px;font-size:12px;box-shadow:0 8px 25px #49372d33;max-width:calc(100% - 32px)}.cloud-bar button{background:#fff;color:#61524b;border-radius:10px;padding:7px 10px;font-size:12px;font-weight:700;white-space:nowrap}`;
    document.head.appendChild(css);
    window.startLineLogin = startLogin;
    window.createTeam = createClass;
    window.joinTeam = joinClass;
    window.bearCloud = { finishLogin, pull, push, exportBackup, importBackup, merge, get user() { return user; }, get ws() { return ws; } };
    const bf = document.getElementById("backupFile");
    if (bf) bf.addEventListener("change", (e) => { const f = e.target.files?.[0]; if (f) importBackup(f); e.target.value = ""; });
    const be = document.getElementById("backupExport");
    if (be) be.onclick = exportBackup;
    if (!window.supabase) { renderCloudUI(); return; }
    sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, { auth: { persistSession: true, autoRefreshToken: true, storageKey: "bear_cloud_auth" } });
    const { data } = await sb.auth.getSession();
    user = data.session?.user || null;
    if (user) { try { await afterSignIn(false); } catch (e) { console.error(e); setStatus("暫時無法同步，連上網路後會自動重試"); } }
    else {
      renderCloudUI();
      // coming back from the LINE login page
      if (CFG.liffId && (/[?&](code|liffClientId|liff\.state)=/.test(location.search) || /\bLine\//i.test(navigator.userAgent))) {
        try { await initLiff(); if (liff.isLoggedIn()) await exchange(liff.getIDToken()); history.replaceState(null, "", location.pathname); }
        catch (e) { console.error(e); toast("登入失敗：" + (e.message || e)); }
      }
    }
    window.addEventListener("online", flushDirty);
    document.addEventListener("visibilitychange", () => { if (!document.hidden && user) flushDirty().then(() => pull({ reloadIfChanged: false }).then((c) => c && needsRefresh("雲端有新的資料"))); });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
