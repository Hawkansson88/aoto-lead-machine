/**
 * AOTO Lead Machine — Acceptera offert
 * Uppdaterar offertstatus och skickar e-post till offertens skapare.
 *
 * Miljövariabler:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   RESEND_API_KEY (valfritt — utan den loggas mail till konsolen)
 *   QUOTE_FROM_EMAIL (default: offert@aoto.se)
 */

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function sendEmail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.QUOTE_FROM_EMAIL || "AOTO Offert <offert@aoto.se>";

  if (!apiKey) {
    console.log("[accept-quote] E-post (RESEND_API_KEY saknas):", { to, subject });
    return { ok: true, simulated: true };
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to: [to], subject, html }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error("Resend error:", err);
    return { ok: false, error: err };
  }
  return { ok: true };
}

export async function handler(event) {
  if (event.httpMethod !== "POST") {
    return json(405, { success: false, error: "Method not allowed" });
  }

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return json(500, { success: false, error: "Serverkonfiguration saknas" });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { success: false, error: "Ogiltig JSON" });
  }

  const publicToken = body.public_token?.trim();
  const email = body.email?.trim().toLowerCase();

  if (!publicToken) return json(400, { success: false, error: "Offertlänk saknas" });
  if (!email || !isValidEmail(email)) {
    return json(400, { success: false, error: "Ange en giltig e-postadress" });
  }

  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  };

  try {
    const fetchRes = await fetch(
      `${SUPABASE_URL}/rest/v1/quotes?public_token=eq.${publicToken}&select=*`,
      { headers }
    );
    const quotes = await fetchRes.json();
    const quote = Array.isArray(quotes) ? quotes[0] : null;

    if (!quote) {
      return json(404, { success: false, error: "Offerten hittades inte" });
    }
    if (quote.status === "accepted") {
      return json(400, { success: false, error: "Offerten är redan accepterad" });
    }
    if (quote.status !== "published") {
      return json(400, { success: false, error: "Offerten kan inte accepteras" });
    }
    if (quote.valid_until < new Date().toISOString().slice(0, 10)) {
      return json(400, { success: false, error: "Offerten har gått ut" });
    }

    const now = new Date().toISOString();
    const patchRes = await fetch(`${SUPABASE_URL}/rest/v1/quotes?id=eq.${quote.id}`, {
      method: "PATCH",
      headers: {
        ...headers,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify({
        status: "accepted",
        accepted_at: now,
        accepted_email: email,
      }),
    });

    if (!patchRes.ok) {
      return json(500, { success: false, error: "Kunde inte spara acceptans" });
    }

    const creatorEmail = quote.creator_email;
    const items = (quote.line_items || [])
      .map((r) => `<tr><td style="padding:8px 12px;border-bottom:1px solid #e6eaf0">${r.label}</td><td style="padding:8px 12px;border-bottom:1px solid #e6eaf0;font-weight:600">${r.value}</td></tr>`)
      .join("");

    const mailHtml = `
      <div style="font-family:sans-serif;max-width:560px;color:#14202e">
        <h2 style="color:#0d1424">Offert accepterad</h2>
        <p><strong>${quote.company_name}</strong> (${quote.org_nr}) har accepterat din offert.</p>
        <p>Signerad av: <strong>${email}</strong></p>
        <p>Tidpunkt: ${new Date(now).toLocaleString("sv-SE")}</p>
        <table style="width:100%;border-collapse:collapse;margin-top:16px;font-size:14px">
          <thead><tr style="background:#f3f5f8">
            <th style="padding:8px 12px;text-align:left">Villkor</th>
            <th style="padding:8px 12px;text-align:left">Värde</th>
          </tr></thead>
          <tbody>${items}</tbody>
        </table>
        <p style="margin-top:24px;color:#69748a;font-size:13px">AOTO Lead Machine</p>
      </div>`;

    const mailResult = await sendEmail({
      to: creatorEmail,
      subject: `Offert accepterad — ${quote.company_name}`,
      html: mailHtml,
    });

    return json(200, {
      success: true,
      email_sent: mailResult.ok,
      email_simulated: !!mailResult.simulated,
    });
  } catch (err) {
    console.error("accept-quote error:", err);
    return json(500, { success: false, error: err.message });
  }
}
