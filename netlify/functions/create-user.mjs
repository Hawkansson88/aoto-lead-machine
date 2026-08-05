/**
 * Admin: skapa användare med roll, namn och lösenord.
 */

async function verifyUser(token, sbUrl, anonKey) {
  const res = await fetch(`${sbUrl}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: anonKey },
  });
  if (!res.ok) return null;
  return res.json();
}

async function getProfile(userId, sbUrl, serviceKey) {
  const res = await fetch(
    `${sbUrl}/rest/v1/profiles?id=eq.${userId}&select=role,first_name,last_name,email`,
    {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
      },
    }
  );
  if (!res.ok) return null;
  const rows = await res.json();
  return rows[0] || null;
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

export async function handler(event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_ANON_KEY) {
    return json(500, { error: "Saknar miljövariabler" });
  }

  const jwt = (event.headers.authorization || "").replace("Bearer ", "");
  if (!jwt) return json(401, { error: "Ingen session" });

  const caller = await verifyUser(jwt, SUPABASE_URL, SUPABASE_ANON_KEY);
  if (!caller) return json(401, { error: "Ogiltig session" });

  const callerProfile = await getProfile(caller.id, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  if (!callerProfile || callerProfile.role !== "admin") {
    return json(403, { error: "Endast admin kan skapa användare" });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Ogiltig JSON" });
  }

  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  const firstName = String(body.first_name || "").trim();
  const lastName = String(body.last_name || "").trim();
  const role = String(body.role || "saljare").trim();

  if (!email || !password) return json(400, { error: "E-post och lösenord krävs" });
  if (password.length < 6) return json(400, { error: "Lösenordet måste vara minst 6 tecken" });
  if (!firstName) return json(400, { error: "Förnamn krävs" });
  if (!["admin", "saljare", "kredit"].includes(role)) {
    return json(400, { error: "Ogiltig roll" });
  }

  const createRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email,
      password,
      email_confirm: true,
      user_metadata: { first_name: firstName, last_name: lastName, role },
    }),
  });

  const created = await createRes.json();
  if (!createRes.ok) {
    const msg = created?.msg || created?.error_description || created?.message || "Kunde inte skapa användare";
    return json(400, { error: msg });
  }

  const userId = created.id;
  const profileRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles?on_conflict=id`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=representation",
    },
    body: JSON.stringify({
      id: userId,
      email,
      first_name: firstName,
      last_name: lastName,
      role,
      updated_at: new Date().toISOString(),
    }),
  });

  if (!profileRes.ok) {
    const errText = await profileRes.text();
    console.error("Profile upsert failed:", errText);
    return json(500, { error: "Användare skapades men profilen kunde inte sparas" });
  }

  return json(200, {
    success: true,
    user: { id: userId, email, first_name: firstName, last_name: lastName, role },
  });
}
