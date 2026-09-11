import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * The public way in: the demo merchant's billing link. A customer never types a path -- they open
 * a link a merchant sent -- so the site's "try it" is exactly that, a merchant's link.
 */
export function GET(req) {
  const token = process.env.DEMO_PAY_TOKEN;
  if (!token) return new NextResponse('The demo link is not configured on this deployment.', { status: 404 });
  return NextResponse.redirect(new URL(`/pay/${token}`, req.url), 307);
}
