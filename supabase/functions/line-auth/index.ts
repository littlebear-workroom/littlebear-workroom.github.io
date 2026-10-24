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
    const { idToken, pair, claim } = await req.json();
    const okNonce = (v: unknown) => typeof v === "string" && /^[A-Za-z0-9]{24,64}$/.test(v);
    // The home-screen app asks whether its login (finished in Safari) is ready.
    if (claim !== undefined) {
      if (!okNonce(claim)) return json({ error: "bad code" }, 400);
      const { data } = await admin.from("login_pairs").delete().eq("nonce", claim).gte("created_at", new Date(Date.now() - 15 * 60e3).toISOString()).select("token_hash").maybeSingle();
      return json(data ? { token_hash: data.token_hash } : { pending: true });
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
    if (okNonce(pair)) {
      // Login was finished outside the home-screen app: park it for the app to pick up.
      await admin.from("login_pairs").delete().lt("created_at", new Date(Date.now() - 15 * 60e3).toISOString());
      await admin.from("login_pairs").upsert({ nonce: pair, token_hash: link.properties.hashed_token, created_at: new Date().toISOString() });
      return json({ paired: true, name: info.name ?? "" });
    }
    return json({ token_hash: link.properties.hashed_token, email, name: info.name ?? "", picture: info.picture ?? "" });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
