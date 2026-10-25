// Presentation only: the game still redeems its PKCE-bound ticket and decides the
// authentication result. Desktop browsers cannot open the mobile app scheme.
export function browserCompletionResponse(target: string, userAgent?: string | null): Response {
  const headers = {
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  };
  if (/Android|iPhone|iPad|iPod/i.test(userAgent ?? '')) {
    return new Response(null, { status: 303, headers: { ...headers, Location: target } });
  }
  return new Response('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Epic Conquest authorization</title><main><h1>Browser authorization finished</h1><p>Return to Epic Conquest to continue.</p><p>You can close this tab.</p></main></html>', {
    headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" },
  });
}
