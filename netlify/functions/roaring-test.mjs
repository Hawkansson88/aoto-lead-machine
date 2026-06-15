const ROARING_TOKEN_URL = "https://api.roaring.io/token";
const TEST_COMPANY_ID = "_rd5b5368c2267279bfc6a933e39b3f4a6";

const CANDIDATE_URLS = [
  `https://api.roaring.io/se/company/overview/2.0/overview/${TEST_COMPANY_ID}`,
  `https://api.roaring.io/se/company/overview/2.0/overview?companyId=${TEST_COMPANY_ID}`,
  `https://api.roaring.io/se/company/overview/2.0/${TEST_COMPANY_ID}`,
];

export async function handler() {
  const { ROARING_CLIENT_ID, ROARING_CLIENT_SECRET } = process.env;

  try {
    const basic = btoa(`${ROARING_CLIENT_ID}:${ROARING_CLIENT_SECRET}`);
    const tokenRes = await fetch(ROARING_TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    if (!tokenRes.ok) throw new Error(`Token error: ${tokenRes.status}`);
    const { access_token } = await tokenRes.json();

    const results = [];
    for (const url of CANDIDATE_URLS) {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${access_token}` },
      });
      const body = await res.text();
      results.push({ url, status: res.status, body });
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(results, null, 2),
    };
  } catch (err) {
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: err.message }),
    };
  }
}