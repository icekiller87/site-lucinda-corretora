import { createHmac } from "node:crypto";

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json; charset=utf-8" }
});

const escapeHtml = (value) => String(value).replace(/[&<>'"]/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
})[char]);

const allowedLives = new Set(["1 pessoa", "2 pessoas", "3 a 5 pessoas", "6 a 29 pessoas", "30 ou mais pessoas"]);
const allowedPlans = new Set(["Individual ou familiar", "Empresarial / PME", "Melhor idade", "Odontológico", "Quero ajuda para decidir"]);
const validBrazilianMobile = /^(?:11|12|13|14|15|16|17|18|19|21|22|24|27|28|31|32|33|34|35|37|38|41|42|43|44|45|46|47|48|49|51|53|54|55|61|62|63|64|65|66|67|68|69|71|73|74|75|77|79|81|82|83|84|85|86|87|88|89|91|92|93|94|95|96|97|98|99)9\d{8}$/;

async function saveLead(lead) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error("Supabase is not configured");
  const response = await fetch(`${url}/rest/v1/lucinda_leads_contacts`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      apikey: key,
      authorization: `Bearer ${key}`,
      prefer: "return=minimal"
    },
    body: JSON.stringify(lead)
  });
  if (!response.ok) {
    const detail = await response.text();
    const error = new Error(`Supabase rejected the lead: ${response.status} ${detail.slice(0, 300)}`);
    if (detail.includes("CONTACT_COOLDOWN_24H")) error.code = "CONTACT_COOLDOWN_24H";
    throw error;
  }
}

async function sendNotification(lead) {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.RESEND_TO_EMAIL;
  if (!apiKey || !to) return false;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", "idempotency-key": `lucinda-lead-${lead.request_id}` },
    body: JSON.stringify({
      from: process.env.RESEND_FROM_EMAIL || "Lucinda Menezes <onboarding@resend.dev>",
      to: [to],
      subject: `Novo pedido de retorno: ${lead.visitor_name}`,
      html: `<div style="font-family:Arial,sans-serif;color:#0b1f3a;line-height:1.65"><h2 style="color:#0b4a7f">Novo pedido de retorno</h2><p><strong>Nome:</strong> ${escapeHtml(lead.visitor_name)}</p><p><strong>WhatsApp:</strong> ${escapeHtml(lead.visitor_phone)}</p><p><strong>Idade:</strong> ${lead.holder_age}</p><p><strong>Quantidade:</strong> ${escapeHtml(lead.lives)}</p><p><strong>Tipo de plano:</strong> ${escapeHtml(lead.plan_type)}</p><p><strong>Local informado:</strong> ${escapeHtml(lead.location)}</p><p><strong>Localização aproximada do acesso:</strong> ${escapeHtml([lead.access_city, lead.access_country].filter(Boolean).join(", ") || "Não identificada")}</p><p style="color:#526d88;font-size:13px">O campo livre de prioridades não foi armazenado neste cadastro.</p></div>`
    })
  });
  if (!response.ok) throw new Error(`Resend rejected the message: ${response.status}`);
  return true;
}

function createContactToken(requestId, phone) {
  const secret = process.env.RESEND_API_KEY;
  if (!secret) return null;
  return createHmac("sha256", secret).update(`${requestId}|${phone}`).digest("hex");
}

export default async (request, context) => {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const body = await request.json();
    const name = String(body.name || "").trim().replace(/\s+/g, " ").slice(0, 100);
    const phone = String(body.phone || "").replace(/\D/g, "");
    const age = Number(body.age);
    const location = String(body.location || "").trim().slice(0, 140);
    const requestId = String(body.request_id || "");
    const valid = body.callback_consent === true && /^[0-9a-f-]{36}$/i.test(requestId) && name.split(" ").length >= 2 && validBrazilianMobile.test(phone) && Number.isInteger(age) && age >= 0 && age <= 120 && allowedLives.has(body.lives) && allowedPlans.has(body.plan_type) && location.length >= 4;
    if (!valid) {
      console.warn("Lead validation rejected", { consent: body.callback_consent === true, requestId: /^[0-9a-f-]{36}$/i.test(requestId), name: name.split(" ").length >= 2, phone: validBrazilianMobile.test(phone), age: Number.isInteger(age) && age >= 0 && age <= 120, lives: allowedLives.has(body.lives), plan: allowedPlans.has(body.plan_type), location: location.length >= 4 });
      return json({ error: "Invalid contact" }, 400);
    }

    const lead = {
      request_id: requestId,
      visitor_name: name,
      visitor_phone: phone,
      holder_age: age,
      lives: body.lives,
      plan_type: body.plan_type,
      location,
      access_city: context.geo?.city || null,
      access_country: context.geo?.country?.name || null,
      callback_consent: true,
      status: "unread"
    };

    await saveLead(lead);
    let emailSent = false;
    try { emailSent = await sendNotification(lead); } catch {}
    return json({ ok: true, email_sent: emailSent, contact_token: emailSent ? createContactToken(requestId, phone) : null }, 201);
  } catch (error) {
    if (error?.code === "CONTACT_COOLDOWN_24H") {
      return json({ error: "A contact request was already registered in the last 24 hours", code: "CONTACT_COOLDOWN_24H" }, 429);
    }
    console.error("Unable to register Lucinda contact", error instanceof Error ? error.message : "Unknown error");
    return json({ error: "Unable to register contact" }, 502);
  }
};
