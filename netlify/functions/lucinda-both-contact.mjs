import { createHmac, timingSafeEqual } from "node:crypto";

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json; charset=utf-8" }
});

const escapeHtml = (value) => String(value).replace(/[&<>'"]/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
})[char]);
const validBrazilianMobile = /^(?:11|12|13|14|15|16|17|18|19|21|22|24|27|28|31|32|33|34|35|37|38|41|42|43|44|45|46|47|48|49|51|53|54|55|61|62|63|64|65|66|67|68|69|71|73|74|75|77|79|81|82|83|84|85|86|87|88|89|91|92|93|94|95|96|97|98|99)9\d{8}$/;

function validToken(requestId, phone, token, secret) {
  if (!/^[0-9a-f]{64}$/i.test(token)) return false;
  const expected = createHmac("sha256", secret).update(`${requestId}|${phone}`).digest();
  const received = Buffer.from(token, "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export default async (request) => {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const body = await request.json();
    const requestId = String(body.request_id || "");
    const token = String(body.contact_token || "");
    const name = String(body.name || "").trim().replace(/\s+/g, " ").slice(0, 100);
    const phone = String(body.phone || "").replace(/\D/g, "");
    const apiKey = process.env.RESEND_API_KEY;
    const to = process.env.RESEND_TO_EMAIL;
    if (!apiKey || !to) return json({ error: "Notifications unavailable" }, 503);
    if (!/^[0-9a-f-]{36}$/i.test(requestId) || name.split(" ").length < 2 || !validBrazilianMobile.test(phone) || !validToken(requestId, phone, token, apiKey)) {
      return json({ error: "Invalid contact confirmation" }, 403);
    }

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "idempotency-key": `lucinda-both-${requestId}`
      },
      body: JSON.stringify({
        from: process.env.RESEND_FROM_EMAIL || "Lucinda Menezes <onboarding@resend.dev>",
        to: [to],
        subject: `Re: Novo pedido de retorno: ${name}`,
        html: `<div style="font-family:Arial,sans-serif;color:#0b1f3a;line-height:1.65"><h2 style="color:#0b4a7f">Este contato também abriu o WhatsApp</h2><p><strong>Nome:</strong> ${escapeHtml(name)}</p><p><strong>WhatsApp:</strong> ${escapeHtml(phone)}</p><p>A pessoa solicitou que Lucinda entrasse em contato e depois também abriu o WhatsApp pelo formulário do site.</p><p style="color:#526d88;font-size:13px">O site consegue confirmar a abertura do WhatsApp, mas não se a mensagem foi efetivamente enviada dentro do aplicativo.</p></div>`
      })
    });
    if (!response.ok) return json({ error: "Unable to send notification" }, 502);
    return json({ ok: true }, 201);
  } catch {
    return json({ error: "Invalid request" }, 400);
  }
};
