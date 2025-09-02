// server.js (ESM) — GlicoCerto
// Rotas: /api/env, /api/paciente/:userId (GET), /api/paciente (POST)
//        /api/ns/latest/:userId (GET)
//        /api/chat (POST), /api/chat-image (POST)
//        /api/refeicoes (GET), /api/refeicoes/:id (DELETE)

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import crypto from "crypto";

dotenv.config();

// __dirname (ESM)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Avisos de env
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
  console.warn("⚠️  SUPABASE_URL/SUPABASE_ANON_KEY ausentes no .env");
}
if (!process.env.OPENAI_API_KEY) {
  console.warn("⚠️  OPENAI_API_KEY ausente — a análise por IA usará fallback simples.");
}

// App
const app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));

// Static (mantém sua pasta ./public)
app.use(express.static(path.join(__dirname, "public")));

// SDKs
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

// Supabase client com JWT do request (RLS)
function supabaseFromReq(req) {
  const token = req.headers?.authorization?.split(" ")[1] || null;
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    global: { headers: token ? { Authorization: `Bearer ${token}` } : {} },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// Utils
const r0 = (n) => Math.round(Number(n || 0));
const sha1Hex = (s) => crypto.createHash("sha1").update(String(s), "utf8").digest("hex");
const stripFences = (s) => String(s || "").replace(/```html|```/g, "").trim();

// Timeout helper (promessa com tempo-limite)
function withTimeout(promise, ms = 45000, label = "Timeout") {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(label)), ms)),
  ]);
}

// Extrai JSON do <pre>…</pre> (carbo_g, pg_cho_equiv_g, resumo)
function pickFromPre(html) {
  let carbo_g = 0, pg_cho_equiv_g = 0, resumo = "";
  let carbo_totais_g = null, fibras_g = null, poliois_g = null;
  try {
    const m = String(html || "").match(/<pre[^>]*>\s*({[\s\S]*?})\s*<\/pre>/i);
    if (m && m[1]) {
      const j = JSON.parse(m[1]);
      carbo_g = Number(j.carbo_g || 0);
      pg_cho_equiv_g = Number(j.pg_cho_equiv_g || 0);
      resumo = String(j.resumo || "");
      // novos campos (opcionais)
      if (j.carbo_totais_g != null) carbo_totais_g = Number(j.carbo_totais_g);
      if (j.fibras_g != null) fibras_g = Number(j.fibras_g);
      if (j.poliois_g != null) poliois_g = Number(j.poliois_g);
    }
  } catch {}
  return { carbo_g, pg_cho_equiv_g, resumo, carbo_totais_g, fibras_g, poliois_g };
}

/* ======================== ENV ======================== */
app.get("/api/env", (req, res) => {
  res.json({
    ok: !!(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY),
    supabaseUrl: process.env.SUPABASE_URL || null,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || null,
    // openai não é exposta ao front por segurança
  });
});

/* ================== PACIENTE (CRUD) ================== */
app.get("/api/paciente/:userId", async (req, res) => {
  try {
    const supabase = supabaseFromReq(req);
    const { userId } = req.params;
    const { data, error } = await supabase
      .from("patient_settings")
      .select("*")
      .eq("user_id", userId)
      .single();
    if (error && error.code !== "PGRST116") throw error;
    res.json({ ok: true, data: data || null });
  } catch (e) {
    console.error("[GET /api/paciente/:userId]", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/paciente", async (req, res) => {
  try {
    const supabase = supabaseFromReq(req);
    const { userId, settings } = req.body || {};
    if (!userId || !settings) {
      return res.status(400).json({ ok: false, error: "userId e settings são obrigatórios" });
    }
    const payload = { user_id: userId, ...settings, updated_at: new Date().toISOString() };
    const { error } = await supabase.from("patient_settings").upsert(payload, { onConflict: "user_id" });
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    console.error("[POST /api/paciente]", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ==================== NIGHTSCOUT ===================== */
async function fetchNightscoutLatest(nsUrl, nsSecret) {
  const base = String(nsUrl || "").replace(/\/+$/, "");
  const url = `${base}/api/v1/entries.json?count=1`;

  // tentativa 1: plaintext (algumas instâncias aceitam)
  let resp = await fetch(url, { headers: nsSecret ? { "API-SECRET": nsSecret } : {} });

  // fallback: SHA-1 no header api-secret
  if (resp.status === 401 || resp.status === 403) {
    const headers = nsSecret ? { "api-secret": sha1Hex(nsSecret) } : {};
    resp = await fetch(url, { headers });
  }
  return resp;
}

app.get("/api/ns/latest/:userId", async (req, res) => {
  try {
    const supabase = supabaseFromReq(req);
    const { userId } = req.params;
    const { data: cfg, error } = await supabase
      .from("patient_settings")
      .select("nightscout_url, nightscout_api_secret")
      .eq("user_id", userId)
      .single();
    if (error && error.code !== "PGRST116") throw error;

    const nsUrl = cfg?.nightscout_url?.trim();
    const nsSecret = cfg?.nightscout_api_secret?.trim();
    if (!nsUrl) return res.json({ ok: false, error: "Nightscout não configurado" });

    const r = await fetchNightscoutLatest(nsUrl, nsSecret);
    if (!r.ok) return res.status(r.status).json({ ok: false, error: `Nightscout HTTP ${r.status}` });
    const arr = await r.json();
    if (!Array.isArray(arr) || !arr.length) return res.json({ ok: false, error: "Sem dados" });

    const e = arr[0];
    res.json({
      ok: true,
      data: {
        mgdl: Math.round(e.sgv ?? e.mgdl ?? e.glucose ?? 0),
        trend: e.direction ?? e.trend ?? null,
        date: new Date(e.dateString || e.date).toISOString(),
      },
    });
  } catch (e) {
    console.error("[GET /api/ns/latest]", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========== Upload Storage (dataURL -> arquivo) ============ */
function dataUrlParse(dataUrl) {
  const m = String(dataUrl).match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return null;
  return {
    mime: m[1],
    buf: Buffer.from(m[2], "base64"),
    ext: (m[1].split("/")[1] || "jpg").split("+")[0],
  };
}
async function uploadMealPhoto(supabase, userId, dataUrl) {
  const p = dataUrlParse(dataUrl);
  if (!p) return null;
  const key = `refeicoes/${userId}/${Date.now()}.${p.ext}`;
  const up = await supabase.storage.from("refeicoes").upload(key, p.buf, {
    contentType: p.mime,
    upsert: true,
  });
  if (up.error) throw up.error;
  const pub = supabase.storage.from("refeicoes").getPublicUrl(key);
  return pub?.data?.publicUrl || null;
}

/* ================ PROMPT DO SISTEMA ================ */
function systemPrompt(cfg) {
  const icr = Number(cfg?.icr || cfg?.insulina_cho || 10);
  const isf = Number(cfg?.isf || cfg?.glicose_insulina || 50);
  const target = Number(cfg?.target || 100);
  const strat = (cfg?.pg_strategy || "regular_now").trim();

  return `
Você é um assistente nutricional/diabetes. Analise a refeição (texto ou foto) e:
1) Estime carboidratos em gramas (carbo_totais_g) e, se possível, fibras (fibras_g) e polióis (poliois_g).
2) Calcule "pg_cho_equiv_g" (equivalente CHO de proteína+gordura) pela regra já instruída.
3) Produza HTML conciso com:
   • Uma seção “Refeição informada”
   • Uma tabela (alimento, porção, carbo(g), kcal aprox) quando possível
   • Seção “Totais” e “Insulina” com contas em tópicos
4) Inclua ao final um bloco <pre>{...}</pre> em JSON com:
   {"carbo_g": <número>, "carbo_totais_g": <número>, "fibras_g": <número>, "poliois_g": <número>, "pg_cho_equiv_g": <número>, "resumo":"<texto curto com a refeição>"}
Observações:
- ICR (g/1U): ${icr}; ISF (mg/dL/1U): ${isf}; alvo: ${target} mg/dL.
- Estratégia proteína+gordura: ${strat}.
- Não repita trechos desnecessários; não inclua markdown fences no HTML.
`;
}

/* ===================== CHAT (TEXTO) ===================== */
app.post("/api/chat", async (req, res) => {
  try {
    const supabase = supabaseFromReq(req);
    const { userId, message, glicemia, pg_strategy, tipo } = req.body || {};
    if (!userId || typeof glicemia !== "number") {
      return res.status(400).json({ ok: false, error: "Parâmetros inválidos." });
    }

    const { data: cfgRaw } = await supabase.from("patient_settings").select("*").eq("user_id", userId).single();
    const cfg = { ...cfgRaw, pg_strategy: pg_strategy || cfgRaw?.pg_strategy || "regular_now" };

    let detalhes_html = "";
    let refeicao_resumo = String(message || "").trim();
    let carbo_g = 0, pg_cho_equiv_g = 0;

    if (openai) {
      const completion = await withTimeout(
        openai.chat.completions.create({
          model: "gpt-4o-mini",
          temperature: 0.1,
          messages: [
            { role: "system", content: systemPrompt(cfg) },
            { role: "user", content: `Refeição textual: ${refeicao_resumo}\nGlicemia: ${glicemia} mg/dL\nTipo: ${tipo || "outro"}` },
          ],
        }),
        45000,
        "Timeout IA (chat-texto)"
      );
      const raw = completion.choices?.[0]?.message?.content || "";
      detalhes_html = stripFences(raw);
      const parsed = pickFromPre(raw);

      // --- Regra SBD Net Carbs (se vierem campos suficientes) ---
      if (parsed.carbo_totais_g != null) {
        const total = Number(parsed.carbo_totais_g || 0);
        const fibras = Number(parsed.fibras_g || 0);
        const poliois = Number(parsed.poliois_g || 0);
        let liquidos = total - (poliois * 0.5) - (fibras > 5 ? fibras * 0.5 : 0);
        carbo_g = Math.max(0, Number(liquidos.toFixed(1)));
      } else {
        carbo_g = parsed.carbo_g;
      }
      pg_cho_equiv_g = parsed.pg_cho_equiv_g;
      if (parsed.resumo) refeicao_resumo = parsed.resumo;
    } else {
      detalhes_html = "<em>Análise automática indisponível.</em>";
    }

    // Configurações
    const icr = Number(cfg?.icr || cfg?.insulina_cho || 10);
    const isf = Number(cfg?.isf || cfg?.glicose_insulina || 50);
    const target = Number(cfg?.target || 100);
    const strat = cfg?.pg_strategy || "regular_now";

    // Doses (mesma regra do front)
    const doseCho = carbo_g / icr;
    const doseCor = Math.max(0, (Number(glicemia) - target) / isf);
    const dosePg  = strat === "regular_now" ? (pg_cho_equiv_g / icr) : 0;

    const resp = {
      ok: true,
      input: { descricao: refeicao_resumo, glicemia, tipo },
      config: { icr, isf, target, pg_strategy: strat, insulina_rapida: cfg?.insulina_rapida || "Fiasp" },
      totais: { carbo_g, pg_cho_equiv_g },
      detalhes_html,
    };

    // Salva histórico
    await supabase.from("refeicoes").insert({
      user_id: userId,
      descricao: refeicao_resumo,
      glicemia: Number(glicemia),
      tipo: String(tipo || "outro"),
      cho_total_g: Number(carbo_g),
      pg_cho_equiv_g: Number(pg_cho_equiv_g),
      dose_rapida_total: Number(doseCho + doseCor),
      dose_regular_pg: Number(dosePg),
      descricao_model: detalhes_html,
      data_hora: new Date().toISOString(),
    });

    res.json(resp);
  } catch (e) {
    console.error("[POST /api/chat]", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* =================== CHAT (IMAGEM) =================== */
app.post("/api/chat-image", async (req, res) => {
  try {
    const supabase = supabaseFromReq(req);
    const { userId, image_data_url, message, glicemia, pg_strategy, tipo } = req.body || {};
    if (!userId || !image_data_url || typeof glicemia !== "number") {
      return res.status(400).json({ ok: false, error: "Parâmetros inválidos." });
    }

    const { data: cfgRaw } = await supabase.from("patient_settings").select("*").eq("user_id", userId).single();
    const cfg = { ...cfgRaw, pg_strategy: pg_strategy || cfgRaw?.pg_strategy || "regular_now" };

    let detalhes_html = "";
    let refeicao_resumo = String(message || "[foto]").trim();
    let carbo_g = 0, pg_cho_equiv_g = 0;

    if (openai) {
      const completion = await withTimeout(
        openai.chat.completions.create({
          model: "gpt-4o-mini",
          temperature: 0.1,
          messages: [
            { role: "system", content: systemPrompt(cfg) },
            {
              role: "user",
              content: [
                { type: "input_text", text: `Analise a imagem e a observação: ${refeicao_resumo}\nGlicemia: ${glicemia} mg/dL\nTipo: ${tipo || "outro"}` },
                { type: "input_image", image_url: image_data_url },
              ],
            },
          ],
        }),
        45000,
        "Timeout IA (chat-image)"
      );
      const raw = completion.choices?.[0]?.message?.content || "";
      detalhes_html = stripFences(raw);
      const parsed = pickFromPre(raw);

      // --- Regra SBD Net Carbs (se vierem campos suficientes) ---
      if (parsed.carbo_totais_g != null) {
        const total = Number(parsed.carbo_totais_g || 0);
        const fibras = Number(parsed.fibras_g || 0);
        const poliois = Number(parsed.poliois_g || 0);
        let liquidos = total - (poliois * 0.5) - (fibras > 5 ? fibras * 0.5 : 0);
        carbo_g = Math.max(0, Number(liquidos.toFixed(1)));
      } else {
        carbo_g = parsed.carbo_g;
      }
      pg_cho_equiv_g = parsed.pg_cho_equiv_g;
      if (parsed.resumo) refeicao_resumo = parsed.resumo;
    } else {
      detalhes_html = "<em>Análise automática indisponível.</em>";
    }

    // Upload da foto para o Storage (gera URL pública)
    const foto_url = await uploadMealPhoto(supabase, userId, image_data_url);

    // Configurações
    const icr = Number(cfg?.icr || cfg?.insulina_cho || 10);
    const isf = Number(cfg?.isf || cfg?.glicose_insulina || 50);
    const target = Number(cfg?.target || 100);
    const strat = cfg?.pg_strategy || "regular_now";

    // Doses
    const doseCho = carbo_g / icr;
    const doseCor = Math.max(0, (Number(glicemia) - target) / isf);
    const dosePg  = strat === "regular_now" ? (pg_cho_equiv_g / icr) : 0;

    // Salva histórico
    await supabase.from("refeicoes").insert({
      user_id: userId,
      descricao: refeicao_resumo,
      glicemia: Number(glicemia),
      tipo: String(tipo || "outro"),
      cho_total_g: Number(carbo_g),
      pg_cho_equiv_g: Number(pg_cho_equiv_g),
      dose_rapida_total: Number(doseCho + doseCor),
      dose_regular_pg: Number(dosePg),
      descricao_model: detalhes_html,
      foto_url,
      data_hora: new Date().toISOString(),
    });

    res.json({
      ok: true,
      input: { descricao: refeicao_resumo, glicemia, tipo },
      config: { icr, isf, target, pg_strategy: strat, insulina_rapida: cfg?.insulina_rapida || "Fiasp" },
      totais: { carbo_g, pg_cho_equiv_g },
      detalhes_html,
      foto_url,
    });
  } catch (e) {
    console.error("[POST /api/chat-image]", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ================== HISTÓRICO (GET/DELETE) ================== */
app.get("/api/refeicoes", async (req, res) => {
  try {
    const supabase = supabaseFromReq(req);
    const { userId, start, end, tipo } = req.query || {};
    if (!userId) return res.status(400).json({ ok: false, error: "userId é obrigatório" });

    let q = supabase.from("refeicoes").select("*").eq("user_id", userId);
    if (start) q = q.gte("data_hora", new Date(start).toISOString());
    if (end) q = q.lte("data_hora", new Date(end).toISOString());
    if (tipo && tipo !== "todos") q = q.eq("tipo", String(tipo));

    const { data, error } = await q.order("data_hora", { ascending: false });
    if (error) throw error;
    res.json({ ok: true, data });
  } catch (e) {
    console.error("[GET /api/refeicoes]", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.delete("/api/refeicoes/:id", async (req, res) => {
  try {
    const supabase = supabaseFromReq(req);
    const { id } = req.params;
    const { userId } = req.query || {};
    if (!userId) return res.status(400).json({ ok: false, error: "userId é obrigatório" });

    const { error } = await supabase.from("refeicoes").delete().eq("id", id).eq("user_id", userId);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    console.error("[DELETE /api/refeicoes/:id]", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ======================== START ====================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ GlicoCerto API rodando em http://localhost:${PORT}`);
});
