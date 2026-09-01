const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});

const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
})[char]);

const HCAPTCHA_SITEKEY = "8a8c292e-bbea-46ea-9390-519cc2ccb4b6";
const states = new Set(["AC","AL","AP","AM","BA","CE","DF","ES","GO","MA","MT","MS","MG","PA","PB","PR","PE","PI","RJ","RN","RS","RO","RR","SC","SP","SE","TO"]);
const experienceLevels = new Set(["Quero começar","Atuo há menos de 2 anos","Atuo de 2 a 5 anos","Atuo há mais de 5 anos"]);
const roles = new Set(["Quero iniciar na área","Corretor autônomo","Trabalho em corretora","Atuo em outra área comercial","Outro perfil"]);
const susepStatuses = new Set(["Tenho registro","Em processo","Ainda não tenho","Não se aplica ao meu momento"]);
const allowedAreas = new Set(["Planos de saúde","Seguros","Odontológico","Plano Pet"]);

async function validateHCaptcha(token, request) {
  const secret = process.env.HCAPTCHA_SECRET_KEY;
  if (!secret) return { ok: false, unavailable: true };
  if (typeof token !== "string" || !token || token.length > 4096) return { ok: false };
  const remoteIp = request.headers.get("x-nf-client-connection-ip") || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "";
  const form = new URLSearchParams({ secret, response: token, sitekey: HCAPTCHA_SITEKEY });
  if (remoteIp) form.set("remoteip", remoteIp);
  try {
    const response = await fetch("https://api.hcaptcha.com/siteverify", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form.toString() });
    const result = await response.json();
    return { ok: response.ok && result.success === true, errors: result["error-codes"] || [] };
  } catch {
    return { ok: false, unavailable: true };
  }
}

async function saveBroker(lead) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error("Supabase is not configured");
  const response = await fetch(`${url}/rest/v1/lucinda_broker_leads`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: key, authorization: `Bearer ${key}`, prefer: "return=minimal" },
    body: JSON.stringify(lead)
  });
  if (!response.ok) {
    const detail = await response.text();
    const error = new Error(`Supabase rejected broker lead: ${response.status} ${detail.slice(0, 240)}`);
    if (response.status === 409 || detail.includes("23505")) error.code = "DUPLICATE_REQUEST";
    if (detail.includes("BROKER_COOLDOWN_24H")) error.code = "BROKER_COOLDOWN_24H";
    throw error;
  }
}

async function sendNotification(lead) {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.RESEND_TO_EMAIL;
  if (!apiKey || !to) return false;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", "idempotency-key": `lucinda-broker-${lead.request_id}` },
    body: JSON.stringify({
      from: process.env.RESEND_FROM_EMAIL || "Lucinda Menezes <onboarding@resend.dev>",
      to: [to],
      subject: `Novo corretor interessado: ${lead.full_name}`,
      html: `<div style="font-family:Arial,sans-serif;color:#0b1f3a;line-height:1.65"><h2 style="color:#0b4a7f">Novo cadastro de corretor parceiro</h2><p><strong>Nome:</strong> ${escapeHtml(lead.full_name)}</p><p><strong>E-mail:</strong> ${escapeHtml(lead.email)}</p><p><strong>WhatsApp:</strong> ${escapeHtml(lead.phone)}</p><p><strong>Cidade/UF:</strong> ${escapeHtml(lead.city)}, ${escapeHtml(lead.state)}</p><p><strong>Experiência:</strong> ${escapeHtml(lead.experience_level)}</p><p><strong>Situação:</strong> ${escapeHtml(lead.professional_status)}</p><p><strong>Áreas:</strong> ${escapeHtml(lead.interest_areas.join(", "))}</p><p><strong>SUSEP:</strong> ${escapeHtml(lead.susep_status)}</p><p><strong>Objetivo:</strong> ${escapeHtml(lead.message || "Não informado")}</p><p style="color:#526d88;font-size:13px">O cadastro completo também está disponível no dashboard privado.</p></div>`
    })
  });
  if (!response.ok) throw new Error(`Resend rejected broker notification: ${response.status}`);
  return true;
}

export default async (request, context) => {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const body = await request.json();
    const captcha = await validateHCaptcha(body.hcaptcha_token, request);
    if (!captcha.ok) return json({ error: captcha.unavailable ? "Security verification unavailable" : "Security verification failed", code: "CAPTCHA_REQUIRED" }, captcha.unavailable ? 503 : 403);

    const requestId = String(body.request_id || "");
    const fullName = String(body.full_name || "").trim().replace(/\s+/g, " ").slice(0, 100);
    const email = String(body.email || "").trim().toLowerCase().slice(0, 140);
    const phone = String(body.phone || "").replace(/\D/g, "").slice(0, 13);
    const city = String(body.city || "").trim().replace(/\s+/g, " ").slice(0, 90);
    const state = String(body.state || "").trim().toUpperCase();
    const message = String(body.message || "").trim().slice(0, 1000) || null;
    const interestAreas = [...new Set(Array.isArray(body.interest_areas) ? body.interest_areas.filter((area) => allowedAreas.has(area)) : [])];
    const valid = body.consent === true && /^[0-9a-f-]{36}$/i.test(requestId) && fullName.split(" ").length >= 2 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && /^\d{10,13}$/.test(phone) && city.length >= 2 && states.has(state) && experienceLevels.has(body.experience_level) && roles.has(body.professional_status) && susepStatuses.has(body.susep_status) && interestAreas.length > 0;
    if (!valid) return json({ error: "Invalid broker registration" }, 400);

    const lead = {
      request_id: requestId,
      full_name: fullName,
      email,
      phone,
      city,
      state,
      experience_level: body.experience_level,
      professional_status: body.professional_status,
      interest_areas: interestAreas,
      susep_status: body.susep_status,
      message,
      access_city: context.geo?.city || null,
      access_country: context.geo?.country?.name || null,
      consent: true,
      status: "new"
    };
    await saveBroker(lead);
    let emailSent = false;
    try { emailSent = await sendNotification(lead); } catch (error) { console.error("Broker saved but email failed", error instanceof Error ? error.message : "Unknown error"); }
    return json({ ok: true, email_sent: emailSent }, 201);
  } catch (error) {
    if (error?.code === "DUPLICATE_REQUEST" || error?.code === "BROKER_COOLDOWN_24H") return json({ error: "Registration already received in the last 24 hours", code: "DUPLICATE_REQUEST" }, 429);
    console.error("Unable to register Lucinda broker", error instanceof Error ? error.message : "Unknown error");
    return json({ error: "Unable to register broker" }, 502);
  }
};
