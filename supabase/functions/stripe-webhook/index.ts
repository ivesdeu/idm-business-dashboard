import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import Stripe from "npm:stripe@16.12.0";

function json(status: number, payload: Record<string, unknown>) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method !== "POST") {
    return json(405, { error: "Method not allowed." });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY");
  const stripeWebhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  if (!supabaseUrl || !serviceRoleKey || !stripeSecretKey || !stripeWebhookSecret) {
    return json(500, {
      error:
        "Missing env vars. Expected SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET.",
    });
  }

  const sig = req.headers.get("stripe-signature");
  if (!sig) return json(400, { error: "Missing stripe-signature header." });

  const rawBody = await req.text();
  const stripe = new Stripe(stripeSecretKey, { appInfo: { name: "idm-business-dashboard", version: "1.0.0" } });
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(rawBody, sig, stripeWebhookSecret);
  } catch (err) {
    const details = err instanceof Error ? err.message : "Invalid signature";
    return json(400, { error: "Webhook signature verification failed.", details });
  }

  const admin = createClient(supabaseUrl, serviceRoleKey);

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      const invoiceId = session.metadata?.invoice_id || session.client_reference_id;
      if (!invoiceId) return json(200, { ok: true, ignored: "No invoice_id metadata." });

      const paidAtIso = new Date().toISOString();
      const paymentIntent =
        typeof session.payment_intent === "string"
          ? session.payment_intent
          : session.payment_intent?.id || null;
      const customerId =
        typeof session.customer === "string" ? session.customer : session.customer?.id || null;

      const { error } = await admin
        .from("invoices")
        .update({
          status: "paid",
          paid_at: paidAtIso,
          stripe_checkout_session_id: session.id,
          stripe_payment_intent_id: paymentIntent,
          stripe_customer_id: customerId,
          stripe_status: session.payment_status || "paid",
        })
        .eq("id", invoiceId);

      if (error) {
        return json(500, { error: "Failed to update invoice.", details: error.message });
      }
    }

    if (event.type === "checkout.session.expired") {
      const session = event.data.object as Stripe.Checkout.Session;
      const invoiceId = session.metadata?.invoice_id || session.client_reference_id;
      if (invoiceId) {
        await admin
          .from("invoices")
          .update({
            stripe_checkout_session_id: session.id,
            stripe_status: "expired",
          })
          .eq("id", invoiceId);
      }
    }

    return json(200, { ok: true, event: event.type });
  } catch (err) {
    const details = err instanceof Error ? err.message : "Unhandled webhook error";
    return json(500, { error: "Webhook handler failed.", details });
  }
});
