// LINE sign-in for 小熊工作室.
// The page signs in with LIFF and sends us the LINE ID token. We check it with LINE,
// find or create the matching Supabase user, and return a one-time login code
// that the page exchanges for a normal Supabase session.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "use POST" }, 405);
  try {
    const { idToken, pair, claim, code } = await req.json();
    const okNonce = (v: unknown) => typeof v === "string" && /^[A-Za-z0-9]{24,64}$/.test(v);
    const fresh = () => new Date(Date.now() - 15 * 60e3).toISOString();
    // The home-screen app asks whether its login (finished in Safari) is ready.
    if (claim !== undefined) {
      const list = (Array.isArray(claim) ? claim : [claim]).filter(okNonce).slice(0, 6);
      if (!list.length) return json({ error: "bad code" }, 400);
      const { data } = await admin.from("login_pairs").delete().in("nonce", list).gte("created_at", fresh()).select("token_hash, created_at");
      const best = (data || []).sort((a: any, b: any) => b.created_at.localeCompare(a.created_at))[0];
      return json(best ? { token_hash: best.token_hash } : { pending: true });
    }
    // Typed-in 6-digit code from the Safari page.
    if (code !== undefined) {
      if (!/^\d{6}$/.test(String(code))) return json({ error: "請輸入 6 位數字" }, 400);
      await new Promise((r) => setTimeout(r, 400)); // slow down guessing
      const { data } = await admin.from("login_pairs").delete().eq("code", String(code)).gte("created_at", new Date(Date.now() - 10 * 60e3).toISOString()).select("token_hash").maybeSingle();
      return data ? json({ token_hash: data.token_hash }) : json({ error: "登入碼不對或已經過期，請在 Safari 重新登入一次" }, 404);
    }
    if (!idToken) return json({ error: "缺少 LINE 登入資訊" }, 400);
    const channelId = Deno.env.get("LINE_CHANNEL_ID");
    if (!channelId) return json({ error: "伺服器還沒設定 LINE Channel ID" }, 500);

    const verify = await fetch("https://api.line.me/oauth2/v2.1/verify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ id_token: idToken, client_id: channelId }),
    });
    const info = await verify.json();
    if (!verify.ok || !info.sub) console.log("LINE verify failed", String(info?.error_description || info?.error || verify.status));
    if (!verify.ok || !info.sub) return json({ error: "LINE 登入驗證失敗，請重新登入", detail: info }, 401);

    const email = `line-${String(info.sub).toLowerCase()}@users.littlebear-workroom.app`;

    const { data: existing } = await admin.from("profiles").select("id").eq("line_user_id", info.sub).maybeSingle();
    let userId = existing?.id as string | undefined;
    if (!userId) {
      const { data, error } = await admin.auth.admin.createUser({
        email,
        email_confirm: true,
        user_metadata: { line_user_id: info.sub, name: info.name, picture: info.picture },
      });
      if (error && !/already/i.test(error.message)) throw error;
      userId = data?.user?.id;
      if (!userId) {
        // user exists in auth but has no profile row yet
        const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
        userId = list?.users.find((u) => u.email === email)?.id;
      }
      if (!userId) throw new Error("建立帳號失敗");
      await admin.from("profiles").upsert({ id: userId, line_user_id: info.sub, display_name: info.name ?? "", picture_url: info.picture ?? "" });
    } else {
      await admin.from("profiles").update({ display_name: info.name ?? "", picture_url: info.picture ?? "" }).eq("id", userId);
    }

    const { data: link, error: linkErr } = await admin.auth.admin.generateLink({ type: "magiclink", email });
    if (linkErr) throw linkErr;
    console.log("line-auth sign-in", pair ? "hand-off to app" : "direct");
    if (okNonce(pair)) {
      // Login was finished outside the home-screen app: park it for the app to pick up.
      await admin.from("login_pairs").delete().lt("created_at", new Date(Date.now() - 15 * 60e3).toISOString());
      const six = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, "0");
      await admin.from("login_pairs").upsert({ nonce: pair, token_hash: link.properties.hashed_token, code: six, created_at: new Date().toISOString() });
      return json({ paired: true, name: info.name ?? "", code: six });
    }
    return json({ token_hash: link.properties.hashed_token, email, name: info.name ?? "", picture: info.picture ?? "" });
  } catch (e) {
    console.log("line-auth error", String((e as Error)?.stack ?? e));
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
