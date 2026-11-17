import { NextResponse } from "next/server";
import crypto from "crypto";

export const runtime = "nodejs";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Payhero-Signature",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

export async function POST(req: Request) {
  const webhookSecret = process.env.PAYHERO_WEBHOOK_SECRET;

  try {
    const raw = await req.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(raw);
    } catch {
      json = {};
    }

    // If secret is set, verify HMAC-SHA256 signature
    if (webhookSecret && webhookSecret.trim()) {
      const signatureHeader =
        req.headers.get("x-payhero-signature") ||
        req.headers.get("X-Payhero-Signature") ||
        "";

      if (!signatureHeader) {
        return NextResponse.json(
          { message: "Missing X-Payhero-Signature header" },
          { status: 401, headers: corsHeaders }
        );
      }

      const expectedSignature =
        "sha256=" + crypto.createHmac("sha256", webhookSecret).update(raw).digest("hex");

      try {
        const valid = crypto.timingSafeEqual(
          Buffer.from(signatureHeader),
          Buffer.from(expectedSignature)
        );
        if (!valid) {
          return NextResponse.json(
            { message: "Invalid signature" },
            { status: 401, headers: corsHeaders }
          );
        }
      } catch {
        return NextResponse.json(
          { message: "Signature verification failed" },
          { status: 401, headers: corsHeaders }
        );
      }
    }

    // PayHero status mapping
    const rawStatus = String(json.status ?? json.Status ?? "").toUpperCase();
    const isSuccess =
      rawStatus === "SUCCESS" ||
      rawStatus === "COMPLETED" ||
      rawStatus === "PAID" ||
      json.success === true;

    const checkoutRequestId =
      (typeof json.reference === "string" ? json.reference : null) ??
      (typeof json.checkoutId === "string" ? json.checkoutId : null) ??
      (typeof json.CheckoutRequestID === "string" ? json.CheckoutRequestID : null);

    const transactionReceipt =
      (typeof json.provider_reference === "string" ? json.provider_reference : null) ??
      (typeof json.third_party_reference === "string" ? json.third_party_reference : null) ??
      (typeof json.payment_reference === "string" ? json.payment_reference : null);

    const reference =
      (typeof json.external_reference === "string" ? json.external_reference : null) ??
      (typeof json.reference === "string" ? json.reference : null);

    return NextResponse.json(
      {
        received: true,
        success: isSuccess,
        checkoutRequestId,
        receipt: transactionReceipt,
        reference,
      },
      { headers: corsHeaders }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Webhook processing failed";
    return NextResponse.json({ message }, { status: 500, headers: corsHeaders });
  }
}
