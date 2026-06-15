export async function handler() {
  const { ROARING_CLIENT_ID, ROARING_CLIENT_SECRET } = process.env;

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      hasClientId: !!ROARING_CLIENT_ID,
      hasClientSecret: !!ROARING_CLIENT_SECRET,
      clientIdLength: ROARING_CLIENT_ID ? ROARING_CLIENT_ID.length : 0,
    }),
  };
}
