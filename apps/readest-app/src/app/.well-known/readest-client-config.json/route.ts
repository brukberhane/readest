import { NextResponse } from 'next/server';
import { getServerRuntimeConfig } from '@/services/runtimeConfig';

export const dynamic = 'force-dynamic';

export function GET() {
  const config = getServerRuntimeConfig();
  return NextResponse.json(config, {
    headers: {
      'Cache-Control': 'no-store, max-age=0',
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
}
