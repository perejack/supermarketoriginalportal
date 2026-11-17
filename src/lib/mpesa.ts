import { toast } from "sonner";

export type PaymentStatusRaw = {
  ResultDesc?: string;
  ResponseDescription?: string;
  resultDesc?: string;
  status?: string;
  rawStatus?: string;
  receiptNumber?: string | null;
  [key: string]: unknown;
};

export type PaymentStatusResponse = {
  status: "completed" | "failed" | "pending";
  receipt?: string;
  raw: PaymentStatusRaw;
};

function createPaymentStatus(
  status: "completed" | "failed" | "pending",
  receipt: string | undefined,
  raw: PaymentStatusRaw
): PaymentStatusResponse & string {
  const obj = new String(status) as any;
  obj.status = status;
  obj.receipt = receipt;
  obj.raw = raw;
  return obj;
}

// PayHero M-Pesa Integration Service
export class MpesaService {
  static formatPhone(phone: string): string {
    let cleaned = String(phone ?? "").replace(/\D/g, "");
    if (cleaned.startsWith("0")) cleaned = "254" + cleaned.substring(1);
    if (cleaned.startsWith("+")) cleaned = cleaned.substring(1);
    if (!cleaned.startsWith("254")) cleaned = "254" + cleaned;
    return cleaned;
  }

  static async initiateSTKPush(
    phoneNumber: string,
    amount: number,
    applicationId?: string,
    _userId?: string,
    _supermarket?: string,
  ): Promise<{ success: boolean; checkoutRequestId?: string; reference?: string; error?: string }> {
    try {
      const response = await fetch("/api/payhero/initiate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          phone: phoneNumber,
          phoneNumber,
          amount: Math.round(Number(amount)),
          description: "food order",
          reference: applicationId || `GROUPSUPER-${Date.now()}`,
          referencePrefix: "GROUPSUPER",
        }),
      });

      const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;

      if (!response.ok || !data || data.success === false) {
        console.error("PayHero payment initiation failed:", data);
        return {
          success: false,
          error:
            (typeof data?.message === "string" ? data.message : null) ??
            "Failed to initiate payment",
        };
      }

      const checkoutId =
        (typeof data.checkoutId === "string" ? data.checkoutId : null) ??
        (typeof data.checkoutRequestId === "string" ? data.checkoutRequestId : null);

      if (!checkoutId) {
        return { success: false, error: "Payment initiated but missing checkoutId" };
      }

      toast.success("STK Push sent! Check your phone and enter PIN.");

      return {
        success: true,
        checkoutRequestId: checkoutId,
        reference: typeof data.reference === "string" ? data.reference : undefined,
      };
    } catch (error: unknown) {
      console.error("PayHero STK Push Error:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to initiate payment",
      };
    }
  }

  static extractReceiptNumber(text: string): string | null {
    const t = String(text ?? "");
    const m = t.match(/\b[A-Z0-9]{8,12}\b/);
    return m ? m[0] : null;
  }

  static async getPaymentStatus(
    checkoutRequestId: string,
  ): Promise<PaymentStatusResponse & string> {
    try {
      const response = await fetch("/api/payhero/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ checkoutId: checkoutRequestId }),
      });

      const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;

      if (!response.ok || !data) {
        // Network/server hiccup — keep polling, don't fail the payment
        return createPaymentStatus("pending", undefined, {
          status: "pending",
          rawStatus: "pending",
          resultDesc: "Checking payment status...",
        });
      }

      if (data.status === "error") {
        // Soft error from our API — keep polling
        return createPaymentStatus("pending", undefined, {
          status: "pending",
          rawStatus: "pending",
          resultDesc: String(data.message ?? ""),
        });
      }

      // Check all the possible "paid" signals from the API layer
      const status = String(data.status ?? data.state ?? "").toLowerCase();
      const rawStatus = String(data.rawStatus ?? "").toLowerCase();
      const resultDesc = String(
        (typeof data.resultDesc === "string" ? data.resultDesc : "") ||
        (typeof data.message === "string" ? data.message : "") ||
        rawStatus
      ).toLowerCase();

      const receiptFromApi =
        typeof data.receiptNumber === "string" && data.receiptNumber.trim()
          ? data.receiptNumber
          : null;
      const receipt = receiptFromApi ?? this.extractReceiptNumber(resultDesc) ?? undefined;

      const raw: PaymentStatusRaw = {
        ResultDesc: resultDesc,
        ResponseDescription: resultDesc,
        resultDesc,
        status,
        rawStatus,
        receiptNumber: receiptFromApi,
      };

      if (
        status === "paid" ||
        status === "success" ||
        status === "completed" ||
        rawStatus === "completed" ||
        rawStatus === "success" ||
        rawStatus === "paid" ||
        resultDesc.includes("success") ||
        resultDesc.includes("processed successfully")
      ) {
        return createPaymentStatus("completed", receipt, raw);
      }

      // Conclusive failure only
      if (
        status === "cancelled" ||
        status === "canceled" ||
        status === "failed" ||
        rawStatus === "cancelled" ||
        rawStatus === "canceled" ||
        rawStatus === "failed" ||
        resultDesc.includes("cancelled by user") ||
        resultDesc.includes("canceled by user") ||
        resultDesc.includes("request cancelled") ||
        resultDesc.includes("insufficient") ||
        resultDesc.includes("wrong pin") ||
        resultDesc.includes("invalid pin")
      ) {
        return createPaymentStatus("failed", receipt, raw);
      }

      return createPaymentStatus("pending", receipt, raw);
    } catch {
      // Any exception (network down etc.) — keep polling silently
      return createPaymentStatus("pending", undefined, {
        status: "pending",
        rawStatus: "pending",
        resultDesc: "Checking payment status...",
      });
    }
  }
}
