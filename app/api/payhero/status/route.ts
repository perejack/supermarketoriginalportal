import { NextResponse } from "next/server";

export const runtime = "nodejs";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const PAYHERO_BASE_URL = "https://backend.payhero.co.ke";

// Hardcoded PayHero credentials overriding env variables
const PAYHERO_AUTH_HEADER =
  "Basic a1FKMHB3YlZRVHhMVjRncjBoTm86MEJDTjBjOUVvUFg0bDh5MHo1R0QyN095alJFU0FIcHd3dDhFMEdlQQ==";

function getAuthHeader(): string {
  // Always use the hardcoded PayHero auth header
  return PAYHERO_AUTH_HEADER;
}

function mapPayheroStatus(rawStatus: string): "paid" | "failed" | "pending" {
  const status = rawStatus.toUpperCase();

  if (status === "SUCCESS" || status === "COMPLETED" || status === "PAID") {
    return "paid";
  }

  if (status === "FAILED" || status === "CANCELLED" || status === "CANCELED") {
    return "failed";
  }

  return "pending";
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

export async function POST(req: Request) {
  const authHeader = getAuthHeader();
  if (!authHeader) {
    return NextResponse.json(
      {
        status: "error",
        message: "PayHero is not configured.",
      },
      { status: 500, headers: corsHeaders }
    );
  }

  try {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    const reference =
      (typeof body?.checkoutId === "string" ? body.checkoutId : undefined) ??
      (typeof body?.checkoutid === "string" ? body.checkoutid : undefined) ??
      (typeof body?.checkoutRequestId === "string" ? body.checkoutRequestId : undefined) ??
      (typeof body?.reference === "string" ? body.reference : undefined);

    if (!reference?.trim()) {
      return NextResponse.json(
        { status: "error", message: "Missing checkoutId/reference" },
        { status: 400, headers: corsHeaders }
      );
    }

    const payheroRes = await fetch(
      `${PAYHERO_BASE_URL}/api/v2/transaction-status?reference=${encodeURIComponent(reference.trim())}`,
      {
        method: "GET",
        headers: {
          Authorization: authHeader,
        },
      }
    );

    const data = (await payheroRes.json().catch(() => null)) as Record<string, unknown> | null;

    if (!payheroRes.ok || !data) {
      return NextResponse.json(
        {
          status: "error",
          message:
            (typeof data?.error_message === "string" ? data.error_message : null) ??
            (typeof data?.message === "string" ? data.message : null) ??
            (typeof data?.error === "string" ? data.error : null) ??
            "Status check failed",
          raw: data,
        },
        { status: payheroRes.status || 500, headers: corsHeaders }
      );
    }

    const rawStatus = String(data.status ?? data.Status ?? "").trim();
    const mappedStatus = mapPayheroStatus(rawStatus);
    const success = data.success === true || mappedStatus === "paid";

    return NextResponse.json(
      {
        success,
        status: mappedStatus,
        state: mappedStatus === "paid" ? "success" : mappedStatus === "failed" ? "failed" : "pending",
        rawStatus,
        resultDesc:
          (typeof data.message === "string" ? data.message : "") ||
          (typeof data.resultDesc === "string" ? data.resultDesc : "") ||
          rawStatus,
        receiptNumber:
          (typeof data.provider_reference === "string" ? data.provider_reference : null) ??
          (typeof data.third_party_reference === "string" ? data.third_party_reference : null) ??
          (typeof data.payment_reference === "string" ? data.payment_reference : null),
        raw: data,
      },
      { headers: corsHeaders }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Status check failed";
    return NextResponse.json({ status: "error", message }, { status: 500, headers: corsHeaders });
  }
}
