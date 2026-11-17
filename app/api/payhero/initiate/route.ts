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
const PAYHERO_CHANNEL_ID = 15406;

function getAuthHeader(): string {
  // Always use the hardcoded PayHero auth header
  return PAYHERO_AUTH_HEADER;
}

function getChannelId(): number {
  // Always use the hardcoded PayHero channel/till ID (15406)
  return PAYHERO_CHANNEL_ID;
}

function normalizePhoneNumber(phone: string | undefined | null): string | null {
  if (!phone) return null;

  const cleaned = String(phone).replace(/\D/g, "");

  // If already in international format
  if (cleaned.startsWith("254") && cleaned.length === 12) {
    return cleaned;
  }

  // If starts with a leading zero (e.g., 0712345678)
  if (cleaned.startsWith("0") && cleaned.length === 10) {
    return "254" + cleaned.slice(1);
  }

  // If local Kenya format without leading zero (e.g., 712345678)
  if ((cleaned.startsWith("7") || cleaned.startsWith("1")) && cleaned.length === 9) {
    return "254" + cleaned;
  }

  // +25407XXXXXXXX typed → stripped = 25407XXXXXXXX (13 digits) — remove the extra 0
  if (cleaned.startsWith("2540") && cleaned.length === 13) {
    return "254" + cleaned.slice(4);
  }

  // 11-digit 254 prefix — pass through (e.g. test numbers)
  if (cleaned.startsWith("254") && cleaned.length === 11) return cleaned;

  return null;
}

function extractReference(data: Record<string, unknown>): string | null {
  const direct =
    data.reference ??
    data.Reference ??
    data.checkoutId ??
    data.checkoutRequestId ??
    data.CheckoutRequestID;

  if (typeof direct === "string" && direct.trim()) return direct;

  const nested = data.data;
  if (nested && typeof nested === "object") {
    const nestedObj = nested as Record<string, unknown>;
    const nestedRef =
      nestedObj.reference ??
      nestedObj.Reference ??
      nestedObj.checkoutId ??
      nestedObj.checkoutRequestId ??
      nestedObj.CheckoutRequestID;
    if (typeof nestedRef === "string" && nestedRef.trim()) return nestedRef;
  }

  return null;
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

export async function POST(req: Request) {
  const authHeader = getAuthHeader();
  const channelId = getChannelId();

  if (!authHeader || !channelId) {
    return NextResponse.json(
      {
        success: false,
        message: "PayHero is not configured.",
      },
      { status: 500, headers: corsHeaders }
    );
  }

  try {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    const rawPhone =
      (typeof body?.phone === "string" ? body.phone : undefined) ??
      (typeof body?.phoneNumber === "string" ? body.phoneNumber : undefined) ??
      (typeof body?.phone_number === "string" ? body.phone_number : undefined) ??
      (typeof body?.msisdn === "string" ? body.msisdn : undefined);

    const normalizedPhone = normalizePhoneNumber(rawPhone);
    if (!normalizedPhone) {
      return NextResponse.json(
        { success: false, message: "Invalid phone number format" },
        { status: 400, headers: corsHeaders }
      );
    }

    const amount = Number(body?.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return NextResponse.json(
        { success: false, message: "Invalid amount" },
        { status: 400, headers: corsHeaders }
      );
    }

    const referencePrefix =
      typeof body?.referencePrefix === "string" ? body.referencePrefix : "GROUPSUPER";
    const externalReference =
      typeof body?.reference === "string" && body.reference.trim()
        ? body.reference
        : `${referencePrefix}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    const payload = {
      amount: Math.round(amount),
      phone_number: normalizedPhone,
      channel_id: channelId,
      provider: "m-pesa",
      external_reference: externalReference,
      customer_name: typeof body?.customer_name === "string" ? body.customer_name : undefined,
      description:
        typeof body?.description === "string" ? body.description : "Processing fee",
    };

    // ── Retry logic: up to 3 attempts with exponential backoff ──────────────
    // PayHero occasionally returns a transient 401/5xx on the first request.
    // Retrying after a short delay resolves it without the user doing anything.
    const MAX_ATTEMPTS = 3;
    const RETRY_DELAYS_MS = [1000, 2500]; // wait 1s before attempt 2, 2.5s before attempt 3

    let payheroRes: Response | null = null;
    let data: Record<string, unknown> | null = null;
    let lastStatus = 500;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      payheroRes = await fetch(`${PAYHERO_BASE_URL}/api/v2/payments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: authHeader,
        },
        body: JSON.stringify(payload),
      });

      data = (await payheroRes.json().catch(() => null)) as Record<string, unknown> | null;
      lastStatus = payheroRes.status;

      // Success — break out immediately
      if (payheroRes.ok && data) break;

      // On a transient error (401, 429, 5xx) wait before retrying
      const isRetryable = lastStatus === 401 || lastStatus === 429 || lastStatus >= 500;
      if (isRetryable && attempt < MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt - 1]));
        continue;
      }

      // Non-retryable error (400, 422, etc.) — fail immediately
      break;
    }

    if (!payheroRes?.ok || !data) {
      return NextResponse.json(
        {
          success: false,
          message:
            (typeof data?.error_message === "string" ? data.error_message : null) ??
            (typeof data?.message === "string" ? data.message : null) ??
            (typeof data?.error === "string" ? data.error : null) ??
            "Payment initiation failed",
          raw: data,
        },
        { status: lastStatus || 500, headers: corsHeaders }
      );
    }

    const checkoutId = extractReference(data);
    const success =
      data.success === true ||
      String(data.status ?? "").toLowerCase() === "success" ||
      Boolean(checkoutId);

    if (!success || !checkoutId) {
      return NextResponse.json(
        {
          success: false,
          message:
            (typeof data.message === "string" ? data.message : null) ??
            "Payment initiation failed",
          raw: data,
        },
        { status: 400, headers: corsHeaders }
      );
    }

    return NextResponse.json(
      {
        success: true,
        checkoutId,
        checkoutRequestId: checkoutId,
        reference: externalReference,
        normalizedPhone: normalizedPhone,
        message: typeof data.message === "string" ? data.message : "STK push initiated",
        raw: data,
      },
      { headers: corsHeaders }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Payment initiation failed";
    return NextResponse.json({ success: false, message }, { status: 500, headers: corsHeaders });
  }
}
